import {
  createTomlLineScanState,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'

type ParsedTomlString = {
  value: string
  endIndex: number
}

export function escapeTomlBasicString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\b', '\\b')
    .replaceAll('\f', '\\f')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
}

export function parseHookStateTomlHeaderKey(line: string): string | null {
  const trimmed = line.trimStart()
  const prefixMatch = /^\[[ \t]*hooks[ \t]*\.[ \t]*state[ \t]*\.[ \t]*/.exec(trimmed)
  return prefixMatch ? parseTomlTableStringKey(trimmed, prefixMatch[0].length) : null
}

export function parseProjectTomlHeaderPath(line: string): string | null {
  const trimmed = line.replace(/\r$/, '').trimStart()
  const prefixMatch = /^\[[ \t]*projects[ \t]*\.[ \t]*/.exec(trimmed)
  return prefixMatch ? parseTomlTableStringKey(trimmed, prefixMatch[0].length) : null
}

function parseTomlTableStringKey(line: string, startIndex: number): string | null {
  const parsedKey = parseTomlSingleLineString(line, startIndex)
  if (!parsedKey) {
    return null
  }
  let index = skipTomlInlineWhitespace(line, parsedKey.endIndex)
  if (line[index] !== ']') {
    return null
  }
  index = skipTomlInlineWhitespace(line, index + 1)
  return index === line.length || line[index] === '#' ? parsedKey.value : null
}

function parseTomlSingleLineString(line: string, startIndex: number): ParsedTomlString | null {
  if (line[startIndex] === '"') {
    return parseTomlBasicSingleLineString(line, startIndex + 1)
  }
  if (line[startIndex] === "'") {
    return parseTomlLiteralSingleLineString(line, startIndex + 1)
  }
  return null
}

function parseTomlBasicSingleLineString(line: string, startIndex: number): ParsedTomlString | null {
  let value = ''
  let index = startIndex
  while (index < line.length) {
    const char = line[index]
    if (char === '"') {
      return { value, endIndex: index + 1 }
    }
    if (char === '\\' && index + 1 < line.length) {
      value += unescapeTomlBasicStringEscape(line[index + 1]!)
      index += 2
      continue
    }
    value += char
    index += 1
  }
  return null
}

function parseTomlLiteralSingleLineString(
  line: string,
  startIndex: number
): ParsedTomlString | null {
  const endIndex = line.indexOf("'", startIndex)
  return endIndex === -1
    ? null
    : { value: line.slice(startIndex, endIndex), endIndex: endIndex + 1 }
}

function skipTomlInlineWhitespace(line: string, startIndex: number): number {
  let index = startIndex
  while (line[index] === ' ' || line[index] === '\t') {
    index += 1
  }
  return index
}

export function findNextTomlTableHeader(text: string): number {
  let cursor = 0
  let scanState = createTomlLineScanState()
  while (cursor < text.length) {
    const newlineIndex = text.indexOf('\n', cursor)
    const lineEnd = newlineIndex === -1 ? text.length : newlineIndex
    const line = text.slice(cursor, lineEnd).replace(/\r$/, '')
    if (isTomlStructuralLine(scanState)) {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('[') && isCompleteTomlTableHeader(trimmed)) {
        return cursor
      }
    }
    scanState = updateTomlLineScanState(scanState, line)
    if (newlineIndex === -1) {
      return -1
    }
    cursor = newlineIndex + 1
  }
  return -1
}

function isCompleteTomlTableHeader(line: string): boolean {
  const isArrayHeader = line.startsWith('[[')
  if (!line.startsWith('[')) {
    return false
  }
  let index = isArrayHeader ? 2 : 1
  let quote: '"' | "'" | null = null
  while (index < line.length) {
    const char = line[index]
    if (quote === '"' && char === '\\' && index + 1 < line.length) {
      index += 2
      continue
    }
    if (quote && char === quote) {
      quote = null
      index += 1
      continue
    }
    if (!quote && (char === '"' || char === "'")) {
      quote = char
      index += 1
      continue
    }
    if (!quote && char === ']') {
      if (isArrayHeader && line[index + 1] !== ']') {
        return false
      }
      const tail = line.slice(index + (isArrayHeader ? 2 : 1))
      return /^\s*(#.*)?$/.test(tail)
    }
    index += 1
  }
  return false
}

function unescapeTomlBasicStringEscape(next: string): string {
  const escaped: Record<string, string> = {
    n: '\n',
    r: '\r',
    t: '\t',
    b: '\b',
    f: '\f',
    '"': '"',
    '\\': '\\'
  }
  return escaped[next] ?? `\\${next}`
}

export function unescapeTomlBasicString(escaped: string): string {
  let result = ''
  let index = 0
  while (index < escaped.length) {
    const char = escaped[index]
    if (char === '\\' && index + 1 < escaped.length) {
      result += unescapeTomlBasicStringEscape(escaped[index + 1]!)
      index += 2
      continue
    }
    result += char
    index += 1
  }
  return result
}
