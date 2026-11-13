import type {
  RuntimeTerminalRead,
  RuntimeTerminalRowMetadata,
  RuntimeTerminalState
} from '../../../../../shared/runtime-terminal-contracts'
import {
  DEFAULT_TERMINAL_READ_LIMIT,
  MAX_TERMINAL_PREVIEW_CHARS,
  MAX_TERMINAL_READ_LIMIT
} from './terminal-tail-limits'
import { buildTailLines } from './terminal-tail-state'
import {
  getTerminalLineOrigins,
  setTerminalLineOrigins,
  sliceTerminalOrigins
} from '../../../../../shared/terminal/output/terminal-content-origin'

export function terminalReadLimit(limit: number | undefined, defaultLimit: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return defaultLimit
  }
  return Math.min(Math.max(1, Math.floor(limit)), MAX_TERMINAL_READ_LIMIT)
}

function trimTerminalPreviewToCharacterBudget(
  lines: string[],
  characterBudget: number
): { tail: string[]; limited: boolean; omittedLineCount: number; slicedFirstLine: boolean } {
  let totalCharacters = lines.reduce((sum, line) => sum + line.length, 0)
  if (totalCharacters <= characterBudget) {
    return { tail: lines, limited: false, omittedLineCount: 0, slicedFirstLine: false }
  }

  let omittedLineCount = 0
  while (
    omittedLineCount < lines.length &&
    totalCharacters - lines[omittedLineCount].length >= characterBudget
  ) {
    totalCharacters -= lines[omittedLineCount].length
    omittedLineCount += 1
  }
  const tail = omittedLineCount > 0 ? lines.slice(omittedLineCount) : [...lines]

  let slicedFirstLine = false
  if (tail.length > 0 && totalCharacters > characterBudget) {
    tail[0] = tail[0].slice(totalCharacters - characterBudget)
    slicedFirstLine = true
  }

  const origins = getTerminalLineOrigins(lines)
  if (origins) {
    const kept = origins.slice(omittedLineCount)
    if (slicedFirstLine) {
      kept[0] = sliceTerminalOrigins(kept[0], totalCharacters - characterBudget)
    }
    setTerminalLineOrigins(tail, kept)
  }
  return { tail, limited: true, omittedLineCount, slicedFirstLine }
}

export function readTerminalTail(args: {
  handle: string
  status: RuntimeTerminalState
  previewLines: string[]
  completedLines: string[]
  partialLine: string
  completedLineCount: number
  bufferTruncated: boolean
  cursor?: number
  limit?: number
}): RuntimeTerminalRead {
  const oldestCursor = Math.max(0, args.completedLineCount - args.completedLines.length)
  const latestCursor = args.completedLineCount

  if (typeof args.cursor === 'number' && args.cursor >= 0) {
    const limit = terminalReadLimit(args.limit, MAX_TERMINAL_READ_LIMIT)
    if (args.cursor > latestCursor) {
      return {
        handle: args.handle,
        status: args.status,
        tail: [],
        truncated: false,
        limited: false,
        oldestCursor: String(oldestCursor),
        nextCursor: String(latestCursor),
        latestCursor: String(latestCursor),
        returnedLineCount: 0
      }
    }
    // Why: cursor reads return completed lines only, so a partial isn't delivered once as "hel" then again as "hello" after the newline.
    const startCursor = Math.max(args.cursor, oldestCursor)
    const startIndex = startCursor - oldestCursor
    const available = args.completedLines.slice(startIndex)
    const tail = available.slice(0, limit)
    const nextCursor = startCursor + tail.length
    return {
      handle: args.handle,
      status: args.status,
      tail,
      truncated: args.cursor < oldestCursor,
      limited: tail.length < available.length,
      oldestCursor: String(oldestCursor),
      nextCursor: String(nextCursor),
      latestCursor: String(latestCursor),
      returnedLineCount: tail.length
    }
  }

  // Why: un-cursored reads are preview reads — return the latest bounded view; the larger buffer stays available via cursor reads + --limit.
  const limit = terminalReadLimit(args.limit, DEFAULT_TERMINAL_READ_LIMIT)
  const allLines = buildTailLines(args.previewLines, args.partialLine)
  const lineBoundedTail = allLines.slice(-limit)
  const charBoundedTail = trimTerminalPreviewToCharacterBudget(
    lineBoundedTail,
    MAX_TERMINAL_PREVIEW_CHARS
  )
  const lineBoundedStartIndex = Math.max(0, allLines.length - lineBoundedTail.length)
  const charBoundedStartIndex = lineBoundedStartIndex + charBoundedTail.omittedLineCount
  const hasPageableOmittedCompletedLines =
    Math.min(args.completedLineCount, charBoundedStartIndex) > 0 ||
    (charBoundedTail.slicedFirstLine && charBoundedStartIndex < args.completedLineCount)
  // Why: a long partial line trimmed by the char budget can't be recovered via nextCursor, since cursor reads only page completed lines.
  const truncatedByNonPageablePartial = charBoundedTail.limited && !hasPageableOmittedCompletedLines
  return {
    handle: args.handle,
    status: args.status,
    tail: charBoundedTail.tail,
    truncated: args.bufferTruncated || truncatedByNonPageablePartial,
    limited: lineBoundedTail.length < allLines.length || charBoundedTail.limited,
    oldestCursor: String(oldestCursor),
    nextCursor: String(latestCursor),
    latestCursor: String(latestCursor),
    returnedLineCount: charBoundedTail.tail.length
  }
}

export function shouldFallbackToVisibleTerminalSnapshot(
  read: RuntimeTerminalRead,
  opts: { cursor?: number; limit?: number }
): boolean {
  if (typeof opts.cursor === 'number') {
    return false
  }
  if (read.tail.length === 0) {
    return false
  }
  const hasSubstantialBlankTail =
    read.limited === true || read.truncated || read.tail.length >= DEFAULT_TERMINAL_READ_LIMIT
  return hasSubstantialBlankTail && read.tail.every((line) => line.trim().length === 0)
}

const nonBlankActionLines = new WeakMap<
  string[],
  { origins: ReturnType<typeof getTerminalLineOrigins>; lines: string[] }
>()

export function visibleNonBlankTerminalLines(lines: string[]): string[] {
  const origins = getTerminalLineOrigins(lines)
  const cached = origins ? nonBlankActionLines.get(lines) : undefined
  if (cached?.origins === origins && cached) {
    return cached.lines
  }
  const indices = lines.flatMap((line, index) => (line.trim() ? [index] : []))
  const result = indices.map((index) => lines[index]!.trimEnd())
  if (origins) {
    setTerminalLineOrigins(
      result,
      indices.map((index) =>
        sliceTerminalOrigins(origins[index], 0, lines[index]!.trimEnd().length)
      )
    )
  }
  if (origins) {
    nonBlankActionLines.set(lines, { origins, lines: result })
  }
  return result
}

export function buildVisibleSnapshotReadFallback(
  read: RuntimeTerminalRead,
  visibleLines: string[],
  limit: number | undefined,
  draft?: string,
  tailRows?: RuntimeTerminalRowMetadata[]
): RuntimeTerminalRead {
  const lineLimit = terminalReadLimit(limit, DEFAULT_TERMINAL_READ_LIMIT)
  const lineBoundedTail = visibleLines.slice(-lineLimit)
  const origins = getTerminalLineOrigins(visibleLines)
  if (origins) {
    setTerminalLineOrigins(lineBoundedTail, origins.slice(-lineLimit))
  }
  const charBoundedTail = trimTerminalPreviewToCharacterBudget(
    lineBoundedTail,
    MAX_TERMINAL_PREVIEW_CHARS
  )
  const boundedRows =
    tailRows?.length === visibleLines.length
      ? tailRows
          .slice(-lineLimit)
          .slice(charBoundedTail.omittedLineCount)
          .map((row, index) => ({ ...row, wrapped: index > 0 && row.wrapped }))
      : undefined
  const { tailRows: _priorRows, ...streamRead } = read
  return {
    ...streamRead,
    tail: charBoundedTail.tail,
    ...(boundedRows ? { tailRows: boundedRows } : {}),
    limited:
      read.limited || lineBoundedTail.length < visibleLines.length || charBoundedTail.limited,
    returnedLineCount: charBoundedTail.tail.length,
    source: 'screen',
    ...(draft ? { draft } : {})
  }
}

export function labelTerminalReadSource(read: RuntimeTerminalRead): RuntimeTerminalRead {
  return read.source ? read : { ...read, source: 'stream' }
}

/** A terminal's last nonblank lines from the tail its record keeps, readable after its process is gone. */
export function terminalLastOutput(
  record: { tailBuffer: string[]; tailPartialLine: string } | undefined,
  lineCount = 15
): string | undefined {
  if (!record) {
    return undefined
  }
  const lines = visibleNonBlankTerminalLines(
    buildTailLines(record.tailBuffer, record.tailPartialLine)
  )
  return lines.slice(-lineCount).join('\n') || undefined
}
