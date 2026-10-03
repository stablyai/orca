import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { parseTomlKeyPath, parseTomlTableHeaderPath } from './config-toml-key-path'
import { escapeTomlBasicString } from './config-toml-syntax'
import {
  parseCodexConfigToml,
  readTomlValueAtPath,
  type TomlKeyPath
} from './codex-config-toml-document'

// Why: every Orca edit of a Codex config.toml locates tables and keys by their
// decoded key path, so `[projects."/x"]`, `["projects"."/x"]` and
// `projects."/x".trust_level` are one identity instead of three spellings.

export type TomlTableContext = { segments: readonly string[]; isArray: boolean }

type TomlLineBounds = {
  /** Offset of the first character of the line. */
  lineStart: number
  /** Offset just past the line's content, before any `\r\n` or `\n`. */
  contentEnd: number
  /** Offset of the next line (content length for the last line). */
  nextLineStart: number
  /** Line text without the trailing `\r` (and without a leading BOM on line one). */
  text: string
}

export type TomlTableLine = TomlLineBounds & {
  kind: 'table'
  segments: readonly string[]
  isArray: boolean
}

export type TomlAssignmentLine = TomlLineBounds & {
  kind: 'assignment'
  table: TomlTableContext
  keySegments: readonly string[]
  /** Offset within `text` of the first value character. */
  valueOffset: number
}

export type TomlStructureLine =
  | TomlTableLine
  | TomlAssignmentLine
  | (TomlLineBounds & { kind: 'other' })

const ROOT_TABLE: TomlTableContext = { segments: [], isArray: false }

export function scanTomlStructure(content: string): TomlStructureLine[] {
  const lines: TomlStructureLine[] = []
  let cursor = 0
  let scanState = createTomlLineScanState()
  let table = ROOT_TABLE
  while (cursor < content.length) {
    const newlineIndex = content.indexOf('\n', cursor)
    const lineEnd = newlineIndex === -1 ? content.length : newlineIndex
    const rawLine = content.slice(cursor, lineEnd)
    const withoutCr = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const text = cursor === 0 && withoutCr.charCodeAt(0) === 0xfeff ? withoutCr.slice(1) : withoutCr
    const bounds: TomlLineBounds = {
      lineStart: cursor,
      contentEnd: cursor + withoutCr.length,
      nextLineStart: newlineIndex === -1 ? content.length : newlineIndex + 1,
      text
    }
    const line = isTomlStructuralLine(scanState)
      ? classifyStructuralLine(bounds, table)
      : { ...bounds, kind: 'other' as const }
    if (line.kind === 'table') {
      table = { segments: line.segments, isArray: line.isArray }
    }
    lines.push(line)
    scanState = updateTomlLineScanState(scanState, text)
    cursor = bounds.nextLineStart
  }
  return lines
}

function classifyStructuralLine(
  bounds: TomlLineBounds,
  table: TomlTableContext
): TomlStructureLine {
  const header = getTomlTableHeader(bounds.text)
  if (header !== null) {
    const parsed = parseTomlTableHeaderPath(header)
    return parsed
      ? { ...bounds, kind: 'table', segments: parsed.segments, isArray: parsed.isArray }
      : { ...bounds, kind: 'other' }
  }
  const key = parseTomlKeyPath(bounds.text)
  if (!key || bounds.text[key.end] !== '=') {
    return { ...bounds, kind: 'other' }
  }
  let valueOffset = key.end + 1
  while (bounds.text[valueOffset] === ' ' || bounds.text[valueOffset] === '\t') {
    valueOffset += 1
  }
  return { ...bounds, kind: 'assignment', table, keySegments: key.segments, valueOffset }
}

/** The decoded absolute key path an assignment defines, or null inside an array of tables. */
export function getAssignmentKeyPath(line: TomlAssignmentLine): readonly string[] | null {
  return line.table.isArray ? null : [...line.table.segments, ...line.keySegments]
}

/** Reads a single-line assignment's value; multiline values read as undefined. */
export function readTomlAssignmentValue(line: TomlAssignmentLine): unknown {
  const parsed = parseCodexConfigToml(line.text)
  return parsed.ok ? readTomlValueAtPath(parsed.table, line.keySegments) : undefined
}

export function tomlKeyPathsEqual(left: TomlKeyPath, right: TomlKeyPath): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index])
}

export function tomlKeyPathStartsWith(path: TomlKeyPath, prefix: TomlKeyPath): boolean {
  return path.length >= prefix.length && prefix.every((segment, index) => segment === path[index])
}

export function formatTomlKeyPath(path: TomlKeyPath): string {
  return path
    .map((segment) =>
      /^[A-Za-z0-9_-]+$/.test(segment) ? segment : `"${escapeTomlBasicString(segment)}"`
    )
    .join('.')
}

export type TomlTableBlock = {
  header: TomlTableLine
  /** Lines after the header up to (not including) the next table header. */
  body: TomlStructureLine[]
  /** Offset just past the block (the next header's line start, or content length). */
  end: number
}

export function getTomlTableBlocks(lines: readonly TomlStructureLine[]): TomlTableBlock[] {
  const blocks: TomlTableBlock[] = []
  let current: TomlTableBlock | null = null
  for (const line of lines) {
    if (line.kind === 'table') {
      if (current) {
        blocks.push(current)
      }
      current = { header: line, body: [], end: line.nextLineStart }
      continue
    }
    if (current) {
      current.body.push(line)
      current.end = line.nextLineStart
    }
  }
  if (current) {
    blocks.push(current)
  }
  return blocks
}
