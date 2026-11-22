import { asRecord } from './session-record-fields'

export function parseJsonObject(line: string): Record<string, unknown> | null {
  if (!line.trim()) {
    return null
  }
  try {
    const parsed = JSON.parse(line) as unknown
    return asRecord(parsed)
  } catch {
    return null
  }
}

const QUOTE = 0x22
const BACKSLASH = 0x5c
const COLON = 0x3a
const COMMA = 0x2c
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d
const OPEN_BRACKET = 0x5b
const CLOSE_BRACKET = 0x5d
const JSON_SCALAR = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/
const LITERAL_LETTERS: ReadonlySet<number> = new Set(
  [...'truefalsn'].map((letter) => letter.charCodeAt(0))
)

/**
 * Raw JSON text of the wanted top-level members of a one-line JSON object, or null when the line
 * is not a complete object. Skipped members are bracket-matched, never parsed, so their size in
 * memory stays the size of the line however many objects they hold.
 */
export function readJsonObjectMembers(
  line: string,
  wanted: ReadonlySet<string>
): Map<string, string> | null {
  const members = new Map<string, string>()
  let index = skipJsonWhitespace(line, 0)
  if (line.charCodeAt(index) !== OPEN_BRACE) {
    return null
  }
  index = skipJsonWhitespace(line, index + 1)
  if (line.charCodeAt(index) === CLOSE_BRACE) {
    return onlyJsonWhitespaceFrom(line, index + 1) ? members : null
  }
  for (;;) {
    if (line.charCodeAt(index) !== QUOTE) {
      return null
    }
    const keyEnd = jsonStringEnd(line, index)
    if (keyEnd === -1) {
      return null
    }
    const key = jsonKey(line, index, keyEnd)
    index = skipJsonWhitespace(line, keyEnd)
    if (key === null || line.charCodeAt(index) !== COLON) {
      return null
    }
    const valueStart = skipJsonWhitespace(line, index + 1)
    const valueEnd = jsonValueEnd(line, valueStart)
    if (valueEnd === -1) {
      return null
    }
    if (wanted.has(key)) {
      // Later duplicates win, as with JSON.parse.
      members.set(key, line.slice(valueStart, valueEnd))
    }
    index = skipJsonWhitespace(line, valueEnd)
    const separator = line.charCodeAt(index)
    if (separator === CLOSE_BRACE) {
      return onlyJsonWhitespaceFrom(line, index + 1) ? members : null
    }
    if (separator !== COMMA) {
      return null
    }
    index = skipJsonWhitespace(line, index + 1)
  }
}

function jsonKey(line: string, start: number, end: number): string | null {
  const raw = line.slice(start, end)
  if (!raw.includes('\\')) {
    return raw.slice(1, -1)
  }
  try {
    const key: unknown = JSON.parse(raw)
    return typeof key === 'string' ? key : null
  } catch {
    return null
  }
}

/** Index just past the closing quote of the string opening at `start`, or -1 when unterminated. */
function jsonStringEnd(line: string, start: number): number {
  let from = start + 1
  for (;;) {
    const quote = line.indexOf('"', from)
    if (quote === -1) {
      return -1
    }
    let backslashes = 0
    while (line.charCodeAt(quote - 1 - backslashes) === BACKSLASH) {
      backslashes++
    }
    if (backslashes % 2 === 0) {
      return quote + 1
    }
    from = quote + 1
  }
}

// Not a validator: it rejects truncated and interleaved writes; values the caller wants still go through JSON.parse.
function jsonValueEnd(line: string, start: number): number {
  const first = line.charCodeAt(start)
  if (first === QUOTE) {
    return jsonStringEnd(line, start)
  }
  if (first !== OPEN_BRACE && first !== OPEN_BRACKET) {
    let index = start
    while (index < line.length && !isJsonScalarEnd(line.charCodeAt(index))) {
      index++
    }
    return index > start && JSON_SCALAR.test(line.slice(start, index)) ? index : -1
  }
  const closers: number[] = []
  let index = start
  while (index < line.length) {
    const code = line.charCodeAt(index)
    if (code === QUOTE) {
      index = jsonStringEnd(line, index)
      if (index === -1) {
        return -1
      }
      continue
    }
    if (code === OPEN_BRACE) {
      closers.push(CLOSE_BRACE)
    } else if (code === OPEN_BRACKET) {
      closers.push(CLOSE_BRACKET)
    } else if (code === CLOSE_BRACE || code === CLOSE_BRACKET) {
      if (closers.pop() !== code) {
        return -1
      }
      if (closers.length === 0) {
        return index + 1
      }
    } else if (!isJsonStructuralOrScalarCode(code)) {
      return -1
    }
    index++
  }
  return -1
}

// Whitespace, separators, and the characters of numbers and true/false/null.
function isJsonStructuralOrScalarCode(code: number): boolean {
  return (
    code === 0x20 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    code === COMMA ||
    code === COLON ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2d ||
    code === 0x2b ||
    code === 0x2e ||
    code === 0x45 ||
    code === 0x65 ||
    LITERAL_LETTERS.has(code)
  )
}

function isJsonScalarEnd(code: number): boolean {
  return (
    code === COMMA ||
    code === CLOSE_BRACE ||
    code === CLOSE_BRACKET ||
    code === 0x20 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d
  )
}

function skipJsonWhitespace(line: string, index: number): number {
  for (;;) {
    const code = line.charCodeAt(index)
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return index
    }
    index++
  }
}

function onlyJsonWhitespaceFrom(line: string, index: number): boolean {
  return skipJsonWhitespace(line, index) >= line.length
}
