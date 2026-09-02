import {
  createTomlLineScanState,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { normalizeCodexHookTrustLookupKey } from './codex-trust-identity'
import { findNextTomlTableHeader, parseHookStateTomlHeaderKey } from './config-toml-syntax'

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
      ranges.push({ start: cursor, headerLineEnd, contentStart: nextCursor, end: blockEnd })
      cursor = Math.max(blockEnd, nextCursor)
      continue
    }
    scanState = updateTomlLineScanState(scanState, line)
    cursor = nextCursor
  }
  return ranges
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
  if (/^[ \t]*\[hooks\.state\][ \t]*(?:#[^\r\n]*)?$/m.test(content)) {
    return content
  }
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const parent = `[hooks.state]${eol}`
  const hookHeader = /^[ \t]*\[hooks\.state\.(?:"|')/m.exec(content)
  if (hookHeader) {
    return `${content.slice(0, hookHeader.index)}${parent}${eol}${content.slice(hookHeader.index)}`
  }
  if (content.length === 0) {
    return parent
  }
  const separator = content.endsWith(`${eol}${eol}`) ? '' : content.endsWith(eol) ? eol : eol + eol
  return `${content}${separator}${parent}`
}
