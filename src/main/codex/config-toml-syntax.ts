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

// Why: Codex's hook_key is `{source}:{event}:{group}:{handler}` for any label (unchanged 0.141-0.158).
export const CODEX_HOOK_TRUST_KEY = /^(.+):[a-z_]+:(?:0|[1-9]\d*):(?:0|[1-9]\d*)$/

// Why (#22592): identity is the decoded key path, so `["hooks"."state"."k"]`
// and `[hooks.state.'k']` are the same table Codex sees.
export function parseHookStateTomlHeaderKey(line: string): string | null {
  if (!mayNameTomlKeys(line, ['hooks', 'state'])) {
    return null
  }
  const segments = parseStandardTableHeaderSegments(line)
  return segments?.length === 3 && segments[0] === 'hooks' && segments[1] === 'state'
    ? (segments[2] ?? null)
    : null
}

// Only the canonical `[projects."path"]` whose path is printable with no `"` or `\`; else the full parse.
const PLAIN_PROJECT_HEADER =
  /^[ \t]*\[[ \t]*projects[ \t]*\.[ \t]*"([ !#-[\]-~\u0080-\uffff]*)"[ \t]*\][ \t]*(?:#.*)?$/

export function parseProjectTomlHeaderPath(line: string): string | null {
  if (!mayNameTomlKeys(line, ['projects'])) {
    return null
  }
  const withoutCr = line.replace(/\r$/, '')
  const plain = PLAIN_PROJECT_HEADER.exec(withoutCr)
  if (plain) {
    return plain[1] ?? null
  }
  const segments = parseStandardTableHeaderSegments(withoutCr)
  return segments?.length === 2 && segments[0] === 'projects' ? (segments[1] ?? null) : null
}

/**
 * Why: header parsing runs per table on every mirror pass. A key spells its
 * name literally unless a basic-string escape is used, so a line without the
 * names and without a backslash cannot name that table.
 */
export function mayNameTomlKeys(line: string, keys: readonly string[]): boolean {
  return line.includes('\\') || keys.every((key) => line.includes(key))
}

export function parseStandardTableHeaderSegments(line: string): readonly string[] | null {
  const header = getTomlTableHeader(line.replace(/\r$/, ''))
  const parsed = header === null ? null : parseTomlTableHeaderPath(header)
  return parsed && !parsed.isArray ? parsed.segments : null
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
