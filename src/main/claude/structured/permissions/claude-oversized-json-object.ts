const SCAN_BATCH_BYTES = 4096
const MAX_JSON_NESTING_DEPTH = 4096

const WHITESPACE = /[ \t\r]+/y
// oxlint-disable-next-line eslint/no-control-regex -- JSON strings must escape U+0000 through U+001F.
const STRING_TEXT = /[^\x00-\x1f"\\]+/y
const STRING_ESCAPE = /\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/y
const DIGITS = /[0-9]+/y
const NUMBER_MARKERS = /[.eE+-]/y

export const OVERLONG_JSON_STRING = Symbol('overlong JSON string')

type JsonString = string | typeof OVERLONG_JSON_STRING
type JsonValue = JsonString | null
type Projection = {
  stringLimit(depth: number, key: boolean): number
  key(depth: number, key: JsonString): void
  value(depth: number, value: JsonValue): void
  open(depth: number, array: boolean): void
  close(depth: number): void
}

type Syntax = 'root' | 'firstKey' | 'key' | 'colon' | 'firstItem' | 'value' | 'separator' | 'done'
type NumberPart =
  | 'sign'
  | 'zero'
  | 'integer'
  | 'decimal'
  | 'fraction'
  | 'exponent'
  | 'exponentDigit'
  | 'power'

function matchAt(pattern: RegExp, input: string, offset: number): string {
  pattern.lastIndex = offset
  return pattern.exec(input)?.[0] ?? ''
}

function readNumberMarker(part: NumberPart, char: string): NumberPart | undefined {
  if (char === '.' && (part === 'zero' || part === 'integer')) {
    return 'decimal'
  }
  if (
    (char === 'e' || char === 'E') &&
    (part === 'zero' || part === 'integer' || part === 'fraction')
  ) {
    return 'exponent'
  }
  if ((char === '-' || char === '+') && part === 'exponent') {
    return 'exponentDigit'
  }
  return undefined
}

function readNumberDigits(part: NumberPart, digits: string): NumberPart | undefined {
  switch (part) {
    case 'sign':
      return digits[0] !== '0' ? 'integer' : digits.length === 1 ? 'zero' : undefined
    case 'integer':
    case 'fraction':
    case 'power':
      return part
    case 'decimal':
      return 'fraction'
    case 'exponent':
    case 'exponentDigit':
      return 'power'
    case 'zero':
      return undefined
  }
}

/** Validate an NDJSON object in bounded batches. The grammar needs one container bit per level. */
export function scanOversizedJsonObject(projection: Projection) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const arrays = new Uint8Array(MAX_JSON_NESTING_DEPTH / 8)
  let depth = 0
  let syntax: Syntax = 'root'
  let valid = true
  let carry = ''
  let number: NumberPart | undefined
  let string: { key: boolean; limit: number; raw: string | typeof OVERLONG_JSON_STRING } | undefined

  const inArray = (): boolean => {
    const level = depth - 1
    return (arrays[level >> 3]! & (1 << (level & 7))) !== 0
  }

  const open = (array: boolean): Syntax | undefined => {
    if (depth === MAX_JSON_NESTING_DEPTH) {
      return undefined
    }
    projection.open(depth, array)
    const byte = depth >> 3
    const bit = 1 << (depth & 7)
    arrays[byte] = array ? arrays[byte]! | bit : arrays[byte]! & ~bit
    depth++
    return array ? 'firstItem' : 'firstKey'
  }

  const close = (): Syntax => {
    projection.close(--depth)
    return depth === 0 ? 'done' : 'separator'
  }

  const writeText = (text: string): boolean => {
    const input = carry + text
    carry = ''
    let offset = 0
    while (offset < input.length) {
      const char = input[offset]!
      if (string) {
        if (char === '"') {
          const { key, limit, raw } = string
          if (limit > 0) {
            const decoded: JsonString = raw === OVERLONG_JSON_STRING ? raw : JSON.parse(`"${raw}"`)
            const value =
              typeof decoded === 'string' && decoded.length > limit ? OVERLONG_JSON_STRING : decoded
            if (key) {
              projection.key(depth, value)
            } else {
              projection.value(depth, value)
            }
          }
          string = undefined
          syntax = key ? 'colon' : 'separator'
          offset++
          continue
        }
        const piece = matchAt(char === '\\' ? STRING_ESCAPE : STRING_TEXT, input, offset)
        if (!piece) {
          if (char === '\\' && input.length - offset < (input[offset + 1] === 'u' ? 6 : 2)) {
            carry = input.slice(offset)
            return true
          }
          return false
        }
        if (string.limit > 0 && string.raw !== OVERLONG_JSON_STRING) {
          string.raw =
            string.raw.length + piece.length > string.limit * 6
              ? OVERLONG_JSON_STRING
              : string.raw + piece
        }
        offset += piece.length
        continue
      }
      if (number) {
        const digits = matchAt(DIGITS, input, offset)
        if (digits) {
          number = readNumberDigits(number, digits)
          if (number === undefined) {
            return false
          }
          offset += digits.length
          continue
        }
        const marker = matchAt(NUMBER_MARKERS, input, offset)
        if (marker) {
          number = readNumberMarker(number, marker)
          if (number === undefined) {
            return false
          }
          offset++
          continue
        }
        if (
          number !== 'zero' &&
          number !== 'integer' &&
          number !== 'fraction' &&
          number !== 'power'
        ) {
          return false
        }
        number = undefined
      }

      const whitespace = matchAt(WHITESPACE, input, offset)
      if (whitespace) {
        offset += whitespace.length
        continue
      }
      offset++
      switch (syntax) {
        case 'root':
          if (char !== '{' || !open(false)) {
            return false
          }
          syntax = 'firstKey'
          break
        case 'firstKey':
        case 'key':
          if (char === '}' && syntax === 'firstKey') {
            syntax = close()
          } else if (char === '"') {
            string = { key: true, limit: projection.stringLimit(depth, true), raw: '' }
          } else {
            return false
          }
          break
        case 'colon':
          if (char !== ':') {
            return false
          }
          syntax = 'value'
          break
        case 'firstItem':
        case 'value':
          if (char === ']' && syntax === 'firstItem') {
            syntax = close()
          } else if (char === '{' || char === '[') {
            const next = open(char === '[')
            if (!next) {
              return false
            }
            syntax = next
          } else {
            syntax = 'separator'
            if (char === '"') {
              const limit = projection.stringLimit(depth, false)
              string = { key: false, limit, raw: '' }
              if (limit === 0) {
                projection.value(depth, null)
              }
            } else if (char === '-' || (char >= '0' && char <= '9')) {
              number = char === '-' ? 'sign' : char === '0' ? 'zero' : 'integer'
              projection.value(depth, null)
            } else {
              const literal =
                char === 'n' ? 'null' : char === 't' ? 'true' : char === 'f' ? 'false' : ''
              if (!literal) {
                return false
              }
              const start = offset - 1
              if (input.length - start < literal.length) {
                carry = input.slice(start)
                syntax = 'value'
                return true
              }
              if (!input.startsWith(literal, start)) {
                return false
              }
              offset = start + literal.length
              projection.value(depth, null)
            }
          }
          break
        case 'separator':
          if (char === ',') {
            syntax = inArray() ? 'value' : 'key'
          } else if (char === (inArray() ? ']' : '}')) {
            syntax = close()
          } else {
            return false
          }
          break
        case 'done':
          return false
      }
    }
    return true
  }

  const decode = (chunk?: Uint8Array): boolean => {
    let text: string
    try {
      text = decoder.decode(chunk, { stream: chunk !== undefined })
    } catch {
      return false
    }
    return writeText(text)
  }

  return {
    write(chunk: Buffer, start: number, end: number): void {
      for (let offset = start; valid && offset < end; offset += SCAN_BATCH_BYTES) {
        valid = decode(chunk.subarray(offset, Math.min(end, offset + SCAN_BATCH_BYTES)))
      }
    },
    finish: (): boolean => valid && decode() && syntax === 'done' && !carry
  }
}
