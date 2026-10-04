import {
  createTomlLineScanState,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { normalizeCodexHookTrustLookupKey } from './codex-trust-identity'
import { findNextTomlTableHeader, parseHookStateTomlHeaderKey } from './config-toml-syntax'
import {
  scanTomlStructure,
  tomlKeyPathsEqual,
  type TomlTableLine
} from './codex-config-toml-structure'

export type HookTrustBlockRange = {
  start: number
  headerLineEnd: number
  contentStart: number
  end: number
}

export function findHookTrustBlockRanges(
  content: string,
  normalizedKeys: ReadonlySet<string>
): HookTrustBlockRange[] {
  const ranges: HookTrustBlockRange[] = []
  if (normalizedKeys.size === 0) {
    return ranges
  }
  let cursor = 0
  let scanState = createTomlLineScanState()
  while (cursor < content.length) {
    const newlineIndex = content.indexOf('\n', cursor)
    const lineEnd = newlineIndex === -1 ? content.length : newlineIndex
    const rawLine = content.slice(cursor, lineEnd)
    const lineWithoutCr = rawLine.replace(/\r$/, '')
    const line =
      cursor === 0 && lineWithoutCr.charCodeAt(0) === 0xfeff
        ? lineWithoutCr.slice(1)
        : lineWithoutCr
    const nextCursor = newlineIndex === -1 ? content.length : newlineIndex + 1
    const headerKey = isTomlStructuralLine(scanState) ? parseHookStateTomlHeaderKey(line) : null
    if (headerKey !== null && normalizedKeys.has(normalizeCodexHookTrustLookupKey(headerKey))) {
      const headerLineEnd = rawLine.endsWith('\r') ? lineEnd - 1 : lineEnd
      const nextHeaderOffset = findNextTomlTableHeader(content.slice(nextCursor))
      const blockEnd = nextHeaderOffset === -1 ? content.length : nextCursor + nextHeaderOffset
      ranges.push({
        start: cursor,
        headerLineEnd,
        contentStart: nextCursor,
        end: excludeTrailingComments(content, nextCursor, blockEnd)
      })
      cursor = Math.max(blockEnd, nextCursor)
      continue
    }
    scanState = updateTomlLineScanState(scanState, line)
    cursor = nextCursor
  }
  return ranges
}

/** Comments directly above the next table describe that table, so an edit of this block keeps them. */
function excludeTrailingComments(content: string, contentStart: number, blockEnd: number): number {
  const lines = content.slice(contentStart, blockEnd).split('\n')
  if (lines.at(-1) === '') {
    lines.pop()
  }
  let firstKept = lines.length
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? ''
    if (line.startsWith('#')) {
      firstKept = index
    } else if (line !== '') {
      break
    }
  }
  if (firstKept === lines.length) {
    return blockEnd
  }
  return (
    contentStart + lines.slice(0, firstKept).reduce((length, line) => length + line.length + 1, 0)
  )
}

export function findAllHookTrustBlocks(content: string): (HookTrustBlockRange & { key: string })[] {
  const blocks: (HookTrustBlockRange & { key: string })[] = []
  let cursor = 0
  let scanState = createTomlLineScanState()
  while (cursor < content.length) {
    const newlineIndex = content.indexOf('\n', cursor)
    const lineEnd = newlineIndex === -1 ? content.length : newlineIndex
    const rawLine = content.slice(cursor, lineEnd)
    const lineWithoutCr = rawLine.replace(/\r$/, '')
    const line =
      cursor === 0 && lineWithoutCr.charCodeAt(0) === 0xfeff
        ? lineWithoutCr.slice(1)
        : lineWithoutCr
    const nextCursor = newlineIndex === -1 ? content.length : newlineIndex + 1
    const key = isTomlStructuralLine(scanState) ? parseHookStateTomlHeaderKey(line) : null
    if (key !== null) {
      const nextHeaderOffset = findNextTomlTableHeader(content.slice(nextCursor))
      const blockEnd = nextHeaderOffset === -1 ? content.length : nextCursor + nextHeaderOffset
      blocks.push({
        key,
        start: cursor,
        headerLineEnd: rawLine.endsWith('\r') ? lineEnd - 1 : lineEnd,
        contentStart: nextCursor,
        end: blockEnd
      })
      cursor = nextCursor
      continue
    }
    scanState = updateTomlLineScanState(scanState, line)
    cursor = nextCursor
  }
  return blocks
}

export function ensureHooksStateParentTable(content: string): string {
  const tables = scanTomlStructure(content).filter(
    (line): line is TomlTableLine => line.kind === 'table' && !line.isArray
  )
  if (tables.some((line) => tomlKeyPathsEqual(line.segments, ['hooks', 'state']))) {
    return content
  }
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const parent = `[hooks.state]${eol}`
  // Why (#22592): any `hooks.state.*` spelling is a child; the parent must precede it.
  const firstHookHeader = tables.find(
    (line) =>
      line.segments.length > 2 && line.segments[0] === 'hooks' && line.segments[1] === 'state'
  )
  if (firstHookHeader) {
    return `${content.slice(0, firstHookHeader.lineStart)}${parent}${eol}${content.slice(firstHookHeader.lineStart)}`
  }
  if (content.length === 0) {
    return parent
  }
  const separator = content.endsWith(`${eol}${eol}`) ? '' : content.endsWith(eol) ? eol : eol + eol
  return `${content}${separator}${parent}`
}
