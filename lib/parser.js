'use strict'

module.exports = Parser

const PRIMITIVE_TYPES = require('./primitive_types.json')
const getType = require('./type_functions.js')

const TransformStream = require('stream').Transform
const assert = require('assert')

//create new objects
function PlainConstructor () {}

function Parser () {
  this.readFunc = function (read, obj, cb) { cb(read, obj) }
  this.constructorFn = PlainConstructor
  this.fixedSize = 0
}

Parser.prototype.parse = function (buffer) {
  var result = null
  var offset = 0

  const Constructor = this.constructorFn

  this.readFunc(
    function (bytes, cb) {
      var off = offset
      offset += bytes
      if (offset > buffer.length) cb(null, 0, true)
      else cb(buffer, off, false)
    },
    new Constructor(),
    function cb (read, obj, done) {
      result = obj
    }
  )

  return result
}

Parser.prototype.stream = function () {
  const readFunc = this.readFunc
  const Constructor = this.constructorFn
  var currentRequest = Infinity
  var currentCallback = null
  const chunks = []
  var chunkTotalLength = 0
  var availableBytes = 0
  var offset = 0

  const stream = new TransformStream({
    readableObjectMode: true,
    transform: function (chunk, encoding, done) {
      chunks.push(chunk)
      availableBytes += chunk.length
      chunkTotalLength += chunk.length

      if (currentRequest <= availableBytes) {
        parseBytes(currentCallback, currentRequest)
      }

      done()
    },
    flush: function (done) {
      if (currentCallback) {
       currentCallback(null, 0, true)
     }
      done()
    }
  })

  readFromStream()

  return stream

  function readFromStream () {
    readFunc(
      function (bytes, cb) {
        if (bytes <= availableBytes) {
          parseBytes(cb, bytes)
        } else {
          currentRequest = bytes
          currentCallback = cb
        }
      },
      new Constructor(),
      function cb (read, obj, done) {
        stream.push(obj)
        readFromStream()
      }
    )
  }

  function parseBytes (cb, bytes) {
    if (chunks[0].length - offset < bytes) {
      if (offset > 1024) {
        chunks[0] = chunks[0].slice(offset)
        chunkTotalLength -= offset
        offset = 0
      }

      chunks[0] = Buffer.concat(chunks, chunkTotalLength)
      chunks.length = 1
    }

    availableBytes -= bytes

    const chunk = chunks[0]
    const curOffset = offset

    if (chunk.length - offset === bytes) {
      chunks.shift()
      chunkTotalLength -= offset
      offset = 0
    } else {
      offset += bytes
    }

    cb(chunk, curOffset, false)
  }
}

Parser.prototype.create = function (constructorFn) {
  this.constructorFn = constructorFn
  return this
}

Parser.prototype.choice = function (varName, options, getChoice) {
  const writeFunc = getWriteFunc(varName, options)

  this._addReadFunc(function (read, obj, cb) {
    const choice = getChoice(obj)
    const TypeConstructor = choice.constructorFn
    choice.readFunc(read, new TypeConstructor(obj), function (read, inner, done) {
      writeFunc(obj, inner)
      cb(read, obj, done)
    })
  })

  this.fixedSize = NaN
}

Parser.prototype.array = function (varName, options, type) {
  var writeFunc = getWriteFunc(varName, options)
  const typeRead = type.readFunc
  const TypeConstructor = type.constructorFn

  const length = options.readUntil === 'eof' || typeof options.length !== 'number'
                  ? function (obj) { return Infinity }
                  : wrapOption(options.length, 'length')

  const readUntil = typeof options.readUntil === 'function' && options.readUntil

  if (readUntil.length > 1) {
    throw new Error('read-ahead is not supported in readUntil functions')
  }

  this.fixedSize += isFinite(type.fixedSize) && typeof options.length === 'number'
                      ? options.length * type.fixedSize : NaN

  // associative arrays
  if (typeof options.key === 'string') {
    const writeVal = writeFunc
    const keyKey = options.key
    writeFunc = function (obj, val) {
      const map = {}
      for (var i = 0; i < val.length; i++) {
        map[val[i][keyKey]] = val[i]
      }
      writeVal(obj, map)
    }
  }

  this._addReadFunc(function (read, obj, cb) {
    assert.equal(cb.length, 3)
    const len = length(obj)
    const vals = []

    readNext()

    function readNext () {
      typeRead(read, new TypeConstructor(obj), function (read, val, done) {
        if (!done) vals.push(val)

        if (vals.length < len && !done && !(readUntil && readUntil(val))) {
          readNext()
        } else if(done && (isFinite(len) || vals.length === 0)) {
          cb(read, null, true)
        } else {
          writeFunc(obj, vals)
          cb(read, obj, done)
        }
      })
    }
  })
}

Parser.prototype.string = function (varName, options) {
  const encoding = options.encoding || 'utf8'
  var writeFunc = getWriteFunc(varName, options)

  if (options.stripNull) {
    const nextFunc = writeFunc
    writeFunc = function stripNull (obj, val) {
      nextFunc(obj, val.replace(/\0+$/, ''))
    }
  }

  const length = options.length
                  ? wrapOption(options.length, 'length')
                  : function (obj) { return Infinity }

  this.fixedSize += typeof options.length === 'number' ? options.length : NaN

  if (options.zeroTerminated) {
    this._addReadFunc(function zeroTerminatedStr (read, obj, cb) {
      assert.equal(cb.length, 3)
      const len = length(obj)
      const parts = []
      var lastBuf = null
      var bufStartOffset = 0
      var curLen = 0

      read(1, function checkByte (buf, offset, done) {
        if (!done && buf !== lastBuf && buf[offset] !== 0) {
          if (lastBuf !== null) {
            parts.push(lastBuf.slice(bufStartOffset))
          }

          lastBuf = buf
          bufStartOffset = offset
        }

        if (done || buf[offset] === 0 || ++curLen === len) {
          if (parts.length > 0) {
            parts.push(lastBuf.slice(bufStartOffset))
            lastBuf = Buffer.concat(parts, curLen)
            bufStartOffset = 0
          }

          if (done && lastBuf === null) {
            cb(read, null, done)
            return
          }

          writeFunc(obj, lastBuf.toString(encoding, bufStartOffset, bufStartOffset + curLen))
          cb(read, obj, done)
        } else {
          read(1, checkByte)
        }
      })
    })
  } else if (options.length) {
    this._addReadLength(writeFunc, length, function (buf, offset, len) {
      return buf.toString(encoding, offset, offset + len)
    })
  } else {
    throw new Error('either a length or zeroTerminated must be defined')
  }
}

Parser.prototype.buffer = function (varName, options) {
  var writeFunc = getWriteFunc(varName, options)

  if (options && options.clone) {
    const nextFunc = writeFunc
    writeFunc = function copyBuf (obj, val) {
      var buf = new Buffer(val.length)
      val.copy(buf)
      nextFunc(obj, buf)
    }
  }

  const length = options.readUntil === 'eof'
                  ? Infinity
                  : wrapOption(options.length, 'length')

  this.fixedSize += typeof options.length === 'number' ? options.length : NaN

  this._addReadLength(writeFunc, length, function (buf, offset, len) {
    return buf.slice(offset, offset + len)
  })
}

Parser.prototype.nest = function (varName, options) {
  const writeFunc = getWriteFunc(varName, options)
  const type = getType(options.type)
  const typeRead = type.readFunc
  const TypeConstructor = type.constructorFn

  this._addReadFunc(function (read, obj, cb) {
    assert.equal(cb.length, 3)
    typeRead(read, new TypeConstructor(obj), function (read, val, done) {
      if (val !== null) writeFunc(obj, val)
      cb(read, val && obj, done)
    })
  })

  this.fixedSize += isFinite(type.fixedSize) ? type.fixedSize : NaN
}

Object.keys(PRIMITIVE_TYPES).forEach(function (key) {
  const readKey = 'read' + key

  Parser.prototype[key.toLowerCase()] = function (varName, options) {
    this._addReadLength(
      getWriteFunc(varName, options),
      PRIMITIVE_TYPES[key],
      function (buf, offset, len) {
        return buf[readKey](offset)
      }
    )

    this.fixedSize += PRIMITIVE_TYPES[key]
  }
})

Parser.prototype.processBitfield = function (bitfield, length) {
  var sum = length

  // TODO use larger groupings
  const readBitfield = bitfield.reduceRight(function (nextFunc, req) {
    const bits = req.i
    const writeFunc = req.vars.length === 1
                        ? getWriteFunc(req.vars[0], req.options)
                        : function (obj, val) {
                          for (var i = 0; i < req.vars.length - 1; i++) {
                            if (!(req.vars[i] in obj)) obj[req.vars[i]] = {} // TODO constructor
                            obj = obj[req.vars[i]]
                          }
                          obj[req.vars[i]] = val
                        }

    const remainingBitsInLastByte = (8 - sum % 8) % 8
    sum -= bits
    const remainingBitsInFirstByte = (8 - sum % 8) % 8
    const bitMask = (1 << remainingBitsInLastByte) - 1

    var processFunc = function (read, obj, remainder, cb) {
      writeFunc(obj, remainder >> remainingBitsInLastByte)
      nextFunc(read, obj, remainder & bitMask, cb)
    }

    const requiredBytes = Math.ceil((bits - remainingBitsInFirstByte) / 8)

    for (var requested = 0; requested < requiredBytes; requested++) {

      const remaining = requiredBytes - requested
      const curRequest = remaining >= 4 ? 4 : remaining >= 2 ? 2 : 1
      processFunc = addByteRequest(processFunc, curRequest, requested <= 4)

      requested += curRequest - 1
    }

    return processFunc
  }, function (read, obj, remainder, cb) {
    cb(read, obj, false)
  })

  this._addReadFunc(function (read, obj, cb) {
    readBitfield(read, obj, 0, cb)
  })

  this.fixedSize += Math.ceil(length / 8)
}

function addByteRequest (nextFunc, bytes, useBinOps) {
  const readFunc = getReadFunc(bytes)
  const sham = bytes << 3

  if (useBinOps) {
    return function readBit (read, obj, remainder, cb) {
      read(bytes, function (buffer, offset, done) {
        if (done) cb(read, null, true)
        else nextFunc(read, obj, remainder << sham | readFunc(buffer, offset), cb)
      })
    }
  }

  // may loose accuracy after 25 bits,
  // can't use binary ops anymore

  const multiplier = 1 << sham

  return function readBitNonBinary (read, obj, remainder, cb) {
    read(bytes, function (buffer, offset, done) {
      if (done) cb(read, null, true)
      else nextFunc(read, obj, (remainder * multiplier) + readFunc(buffer, offset), cb)
    })
  }
}

function getReadFunc (bytes) {
  // use specialized functions for 1, 2 & 4 bytes
  switch (bytes) {
    case 1:
      return function read8 (buffer, offset) {
        return buffer[offset]
      }
    case 2:
      return function read16 (buffer, offset) {
        return buffer.readInt16BE(offset)
      }
    case 4:
      return function read32 (buffer, offset) {
        return buffer.readInt32BE(offset)
      }
  }
}

Parser.prototype._addReadLength = function (writeFunc, length, readVal) {
  if (typeof length === 'number') {
    // TODO use specialized function
    const len = length
    length = function (obj) { return len }
  }

  this._addReadFunc(function readLength (read, obj, cb) {
    assert(cb.length === 3)
    const len = length(obj)

    read(len, function (buf, offset, done) {
      if (done) {
        cb(read, null, done)
      } else {
        writeFunc(obj, readVal(buf, offset, len))
        cb(read, obj, done)
      }
    })
  })
}

Parser.prototype._addReadFunc = function (nextFunc) {
  const readFunc = this.readFunc

  assert.equal(nextFunc.length, 3)
  assert.equal(readFunc.length, 3)

  this.readFunc = function callPrev (read, obj, cb) {
    readFunc(read, obj, function (read, obj, done) {
      if (done) cb(read, null, true)
      else nextFunc(read, obj, cb)
    })
  }

  /*
  this.readFunc.next = nextFunc
  this.readFunc.prev = readFunc
  */
}

/*
function printFunctionTree (func) {
  while (func) {
    console.log(func.next)
    func = func.prev
  }
}
*/

function wrapOption (opt, name) {
  if (typeof opt === 'number') {
    return function (obj) { return opt }
  }

  if (typeof opt === 'string') {
    return function (obj) {
      if (!(opt in obj)) throw new Error(opt + ' not present in object')
      return obj[opt]
    }
  }

  if (typeof opt === 'function') {
    return function (obj) { return opt.call(obj) }
  }

  throw new Error('can\'t handle option ' + name)
}

function getWriteFunc (varName, options) {
  var writeFunc = function (obj, val) {
    obj[varName] = val
  }

  if (options && options.assert) {
    writeFunc = getAssertFunc(varName, options, writeFunc)
  }

  if (options && options.formatter) {
    const formatter = options.formatter
    return function (obj, val) {
      writeFunc(obj, formatter.call(obj, val))
    }
  }

  return writeFunc
}

function getAssertFunc (varName, options, writeFunc) {
  const assert = options.assert

  function errFunc (val) {
    throw new Error('Assert error: `' + varName + '` is `' + val + '`')
  }

  if (typeof assert === 'function') {
    return function assertFn (obj, val) {
      if (!assert.call(obj, val)) errFunc(val)
      else writeFunc(obj, val)
    }
  }

  if (typeof assert === 'string' || typeof assert === 'number') {
    return function assertEq (obj, val) {
      if (val !== assert) errFunc(val)
      else writeFunc(obj, val)
    }
  }

  throw new Error('assert option only supports functions, strings and numbers')
}