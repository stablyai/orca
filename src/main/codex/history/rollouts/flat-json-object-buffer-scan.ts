/**
 * Strict RFC 8259 byte scanner for flat ASCII JSON objects (no escapes, no nested containers).
 * Populates caller-provided key/value byte ranges only when the entire slice is a valid flat
 * JSON object; returns false on escapes, non-ASCII bytes, nested values, or malformed syntax
 * so callers can fall back to `JSON.parse`.
 */
export type FlatJsonFieldSlot = {
  readonly key: Buffer
  valueStart: number
  valueEnd: number
  isString: boolean
}

export function createFlatJsonFieldSlot(key: string): FlatJsonFieldSlot {
  return {
    key: Buffer.from(key, 'ascii'),
    valueStart: -1,
    valueEnd: -1,
    isString: false
  }
}

export function bufferSliceEquals(
  buf: Buffer,
  start: number,
  end: number,
  expected: Buffer
): boolean {
  const len = expected.length
  if (end - start !== len) {
    return false
  }
  for (let i = 0; i < len; i += 1) {
    if (buf[start + i] !== expected[i]) {
      return false
    }
  }
  return true
}

function skipWs(buf: Buffer, pos: number, end: number): number {
  while (pos < end) {
    const b = buf[pos]
    if (b === 0x20 || b === 0x09 || b === 0x0d || b === 0x0a) {
      pos += 1
    } else {
      break
    }
  }
  return pos
}

function scanPlainAsciiStringEnd(buf: Buffer, quotePos: number, end: number): number {
  let pos = quotePos + 1
  while (pos < end) {
    const b = buf[pos]
    if (b === 0x22) {
      return pos
    }
    if (b < 0x20 || b === 0x5c || b >= 0x80) {
      return -1
    }
    pos += 1
  }
  return -1
}

function scanJsonNumberEnd(buf: Buffer, start: number, end: number): number {
  let pos = start
  if (pos < end && buf[pos] === 0x2d) {
    pos += 1
  }
  if (pos >= end) {
    return -1
  }
  if (buf[pos] === 0x30) {
    pos += 1
  } else if (buf[pos] >= 0x31 && buf[pos] <= 0x39) {
    pos += 1
    while (pos < end && buf[pos] >= 0x30 && buf[pos] <= 0x39) {
      pos += 1
    }
  } else {
    return -1
  }
  if (pos < end && buf[pos] === 0x2e) {
    pos += 1
    if (pos >= end || buf[pos] < 0x30 || buf[pos] > 0x39) {
      return -1
    }
    while (pos < end && buf[pos] >= 0x30 && buf[pos] <= 0x39) {
      pos += 1
    }
  }
  if (pos < end && (buf[pos] === 0x65 || buf[pos] === 0x45)) {
    pos += 1
    if (pos < end && (buf[pos] === 0x2b || buf[pos] === 0x2d)) {
      pos += 1
    }
    if (pos >= end || buf[pos] < 0x30 || buf[pos] > 0x39) {
      return -1
    }
    while (pos < end && buf[pos] >= 0x30 && buf[pos] <= 0x39) {
      pos += 1
    }
  }
  return pos
}

function matchLiteral(buf: Buffer, pos: number, end: number, literal: string): number {
  if (pos + literal.length > end) {
    return -1
  }
  for (let i = 0; i < literal.length; i += 1) {
    if (buf[pos + i] !== literal.charCodeAt(i)) {
      return -1
    }
  }
  return pos + literal.length
}

export function scanFlatJsonObjectBuffer(
  buf: Buffer,
  start: number,
  end: number,
  slots: readonly FlatJsonFieldSlot[]
): boolean {
  for (let i = 0; i < slots.length; i += 1) {
    slots[i].valueStart = -1
    slots[i].valueEnd = -1
    slots[i].isString = false
  }
  let pos = skipWs(buf, start, end)
  if (pos >= end || buf[pos] !== 0x7b) {
    return false
  }
  pos = skipWs(buf, pos + 1, end)
  if (pos < end && buf[pos] === 0x7d) {
    return skipWs(buf, pos + 1, end) === end
  }
  while (pos < end) {
    if (buf[pos] !== 0x22) {
      return false
    }
    const keyStart = pos + 1
    const keyEnd = scanPlainAsciiStringEnd(buf, pos, end)
    if (keyEnd === -1) {
      return false
    }
    pos = skipWs(buf, keyEnd + 1, end)
    if (pos >= end || buf[pos] !== 0x3a) {
      return false
    }
    pos = skipWs(buf, pos + 1, end)
    if (pos >= end) {
      return false
    }
    const b = buf[pos]
    let valStart = -1
    let valEnd = -1
    let isString = false
    if (b === 0x22) {
      valStart = pos + 1
      valEnd = scanPlainAsciiStringEnd(buf, pos, end)
      if (valEnd === -1) {
        return false
      }
      isString = true
      pos = valEnd + 1
    } else if (b === 0x74) {
      valStart = pos
      valEnd = matchLiteral(buf, pos, end, 'true')
      if (valEnd === -1) {
        return false
      }
      pos = valEnd
    } else if (b === 0x66) {
      valStart = pos
      valEnd = matchLiteral(buf, pos, end, 'false')
      if (valEnd === -1) {
        return false
      }
      pos = valEnd
    } else if (b === 0x6e) {
      valStart = pos
      valEnd = matchLiteral(buf, pos, end, 'null')
      if (valEnd === -1) {
        return false
      }
      pos = valEnd
    } else if (b === 0x2d || (b >= 0x30 && b <= 0x39)) {
      valStart = pos
      valEnd = scanJsonNumberEnd(buf, pos, end)
      if (valEnd === -1) {
        return false
      }
      pos = valEnd
    } else {
      return false
    }
    for (let i = 0; i < slots.length; i += 1) {
      if (bufferSliceEquals(buf, keyStart, keyEnd, slots[i].key)) {
        slots[i].valueStart = valStart
        slots[i].valueEnd = valEnd
        slots[i].isString = isString
        break
      }
    }
    pos = skipWs(buf, pos, end)
    if (pos >= end) {
      return false
    }
    if (buf[pos] === 0x2c) {
      pos = skipWs(buf, pos + 1, end)
      continue
    }
    if (buf[pos] === 0x7d) {
      return skipWs(buf, pos + 1, end) === end
    }
    return false
  }
  return false
}
