import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { parseTomlTableHeaderPath } from './config-toml-key-path'

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
  return parseTomlTableHeaderLeafKey(line, ['hooks', 'state'])
}

export function parseProjectTomlHeaderPath(line: string): string | null {
  return parseTomlTableHeaderLeafKey(line, ['projects'])
}

// Why (#22592): Codex writes `["projects"."/p"]`; every spelling of the key path must match.
function parseTomlTableHeaderLeafKey(line: string, parent: readonly string[]): string | null {
  const header = getTomlTableHeader(line.replace(/\r$/, ''))
  const table = header === null ? null : parseTomlTableHeaderPath(header)
  if (
    !table ||
    table.isArray ||
    table.segments.length !== parent.length + 1 ||
    parent.some((segment, index) => table.segments[index] !== segment)
  ) {
    return null
  }
  return table.segments.at(-1) ?? null
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
