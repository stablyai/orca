import { containsTerminalVerticalLineControl } from './terminal-ansi-normalization'
import { carryTerminalTailSentinelMatches } from './terminal-tail-sentinel-index'
import {
  applyTerminalLineControls,
  processTerminalTailCompleteSegments,
  splitRetainedTerminalTailSegments,
  trimTerminalLineRight
} from './terminal-tail-line-controls'
import { MAX_TAIL_CHARS, MAX_TAIL_LINES, MAX_TAIL_PARTIAL_CHARS } from './terminal-tail-limits'
import {
  appendNormalizedToMultilineTailBufferUnwindowed,
  type RetainedTailRedrawCursor
} from './terminal-tail-redraw-buffer'

type RetainedTailLineStats = {
  totalChars: number
  /** Whether every line is already right-trimmed, so the redraw prefix trim is a no-op. */
  rightTrimmed: boolean
}

// Why weak + array-keyed: the tail is replaced (never mutated) on every append, so an entry dies
// with the array it describes and only the live tail per PTY is retained. Carrying the char total
// this way replaces a full-tail re-sum on every chunk.
const tailLineStatsByLines = new WeakMap<readonly string[], RetainedTailLineStats>()

function getRetainedTailLineStats(lines: readonly string[]): RetainedTailLineStats {
  const cached = tailLineStatsByLines.get(lines)
  if (cached) {
    return cached
  }
  let totalChars = 0
  let rightTrimmed = true
  for (const line of lines) {
    totalChars += line.length
    if (rightTrimmed && trimTerminalLineRight(line) !== line) {
      rightTrimmed = false
    }
  }
  const stats = { totalChars, rightTrimmed }
  tailLineStatsByLines.set(lines, stats)
  return stats
}

type CarriedTailBuild = {
  lines: string[]
  /** Whether a retention cap dropped a row. */
  truncated: boolean
}

/**
 * The only way to produce a next tail array: `previousLines[keepStart, keepEnd) ++ appended`,
 * capped by `MAX_TAIL_LINES` and — when `charCapPartialChars` is non-null — `MAX_TAIL_CHARS`.
 *
 * Why a constructor rather than three call sites doing their own arithmetic: the carried-match
 * window handed to the sentinel index, the character total, and the array itself are all derived
 * here from the same keep bounds, including whatever the caps drop, so they cannot disagree. The
 * one thing a caller still has to get right is that every row in `appended` is already
 * right-trimmed, which every producer of retained rows does.
 */
function buildCarriedTailLines(
  previousLines: string[],
  keepStart: number,
  keepEnd: number,
  appended: readonly string[],
  charCapPartialChars: number | null
): CarriedTailBuild {
  const keptCount = keepEnd > keepStart ? keepEnd - keepStart : 0
  let totalChars = 0
  let carriedRightTrimmed = true
  if (keptCount > 0) {
    const previousStats = getRetainedTailLineStats(previousLines)
    totalChars = previousStats.totalChars
    carriedRightTrimmed = previousStats.rightTrimmed
    for (let index = 0; index < keepStart; index += 1) {
      totalChars -= previousLines[index]!.length
    }
    for (let index = keepEnd; index < previousLines.length; index += 1) {
      totalChars -= previousLines[index]!.length
    }
  }
  for (const line of appended) {
    totalChars += line.length
  }

  // Both caps only ever drop from the front, so resolve them against the virtual concatenation
  // before the array exists; the surviving keep bounds then define the carried window exactly.
  const combinedLength = keptCount + appended.length
  let dropCount = combinedLength > MAX_TAIL_LINES ? combinedLength - MAX_TAIL_LINES : 0
  for (let index = 0; index < dropCount; index += 1) {
    totalChars -= (
      index < keptCount ? previousLines[keepStart + index]! : appended[index - keptCount]!
    ).length
  }
  if (charCapPartialChars !== null) {
    const charBudget = MAX_TAIL_CHARS - charCapPartialChars
    while (dropCount < combinedLength && totalChars > charBudget) {
      totalChars -= (
        dropCount < keptCount
          ? previousLines[keepStart + dropCount]!
          : appended[dropCount - keptCount]!
      ).length
      dropCount += 1
    }
  }

  if (
    dropCount === 0 &&
    appended.length === 0 &&
    keepStart === 0 &&
    keepEnd === previousLines.length
  ) {
    return { lines: previousLines, truncated: false }
  }

  const droppedFromCarried = dropCount < keptCount ? dropCount : keptCount
  const carriedSourceStart = keepStart + droppedFromCarried
  const carriedCount = keptCount - droppedFromCarried
  const lines = previousLines.slice(carriedSourceStart, keepEnd)
  for (let index = dropCount - droppedFromCarried; index < appended.length; index += 1) {
    lines.push(appended[index]!)
  }

  tailLineStatsByLines.set(lines, {
    totalChars,
    rightTrimmed: carriedCount === 0 || carriedRightTrimmed
  })
  carryTerminalTailSentinelMatches(previousLines, lines, carriedSourceStart, carriedCount)
  return { lines, truncated: dropCount > 0 }
}

export function appendNormalizedToTailBuffer(
  previousLines: string[],
  previousPartialLine: string,
  normalizedChunk: string,
  previousRedrawCursor: RetainedTailRedrawCursor | null = null
): {
  lines: string[]
  partialLine: string
  redrawCursor: RetainedTailRedrawCursor | null
  truncated: boolean
  newCompleteLines: number
  newlyCompletedLines: string[]
} {
  if (normalizedChunk.length === 0) {
    return {
      lines: previousLines,
      partialLine: previousPartialLine,
      redrawCursor: previousRedrawCursor,
      truncated: false,
      newCompleteLines: 0,
      newlyCompletedLines: []
    }
  }

  // Why: fullscreen TUIs emit long newline-free redraw streams; keep the line transcript for pagination but bound partial-line work.
  const previousPartialWasCapped = previousPartialLine.length > MAX_TAIL_PARTIAL_CHARS
  const boundedPreviousPartialLine = previousPartialLine.slice(-MAX_TAIL_PARTIAL_CHARS)
  const combinedChunk = `${boundedPreviousPartialLine}${normalizedChunk}`
  if (previousRedrawCursor || containsTerminalVerticalLineControl(combinedChunk)) {
    return appendNormalizedToMultilineTailBuffer(
      previousLines,
      boundedPreviousPartialLine,
      normalizedChunk,
      previousPartialWasCapped,
      previousRedrawCursor
    )
  }

  // Why: status UIs redraw one line via CR/backspace/erase; retain the latest redraw segment instead of appending every spinner frame.
  const segments = splitRetainedTerminalTailSegments(combinedChunk)
  const pieces = processTerminalTailCompleteSegments(segments.completeSegments)
  const newlyCompletedLines: string[] = []
  for (const piece of pieces) {
    newlyCompletedLines.push(trimTerminalLineRight(piece))
  }
  const partialResult = applyTerminalLineControls(segments.partialSegment)
  const nextPartialLine = trimTerminalLineRight(partialResult.text)
  const retainedPartialLine = nextPartialLine.slice(-MAX_TAIL_PARTIAL_CHARS)
  const newCompleteLines = segments.completeLineCount
  const omittedNewCompleteLines = newCompleteLines - pieces.length

  // The plain path only ever appends, so the whole previous tail carries unless it was discarded.
  const carriesPreviousLines = newCompleteLines === 0 || omittedNewCompleteLines === 0
  const built = buildCarriedTailLines(
    previousLines,
    carriesPreviousLines ? 0 : previousLines.length,
    previousLines.length,
    newlyCompletedLines,
    // Why gated: a chunk that neither completes a line nor grows the partial cannot breach the
    // character cap, and re-checking it would evict on a tail that has not changed size.
    newCompleteLines > 0 || retainedPartialLine.length > previousPartialLine.length
      ? retainedPartialLine.length
      : null
  )
  const nextLines = built.lines
  const truncated =
    previousPartialWasCapped ||
    omittedNewCompleteLines > 0 ||
    nextPartialLine.length > MAX_TAIL_PARTIAL_CHARS ||
    built.truncated

  const redrawCursor =
    !partialResult.hadControl || partialResult.cursorColumn === nextPartialLine.length
      ? null
      : {
          rowFromEnd: 0,
          column: partialResult.cursorColumn
        }

  return {
    lines: nextLines,
    partialLine: retainedPartialLine,
    redrawCursor,
    truncated,
    newCompleteLines,
    newlyCompletedLines
  }
}

// Why a window: the unwindowed impl below is O(tail) per chunk (~93% of the event loop under TUI flood, findings log 2026-07-03); a redraw only touches rows the cursor reaches, so window the suffix and share the prefix by reference. Equivalence fuzz-verified in retained-tail-redraw-window.equivalence.test.ts.
const REDRAW_WINDOW_SAFETY_ROWS = 8

// Why module-level: this ran `new RegExp` per redraw chunk — i.e. per TUI frame per PTY.
// Safe to share because `maxUpwardCursorReach` is synchronous and non-reentrant; it resets
// `lastIndex` before every scan.
const CURSOR_UP_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[(\\d*)(?:;[\\d;]*)?A`, 'g')

function maxUpwardCursorReach(
  normalizedChunk: string,
  previousRedrawCursor: RetainedTailRedrawCursor | null
): number {
  let reach = previousRedrawCursor ? previousRedrawCursor.rowFromEnd : 0
  CURSOR_UP_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CURSOR_UP_PATTERN.exec(normalizedChunk)) !== null) {
    reach += match[1] ? Number.parseInt(match[1], 10) : 1
  }
  return reach
}

function appendNormalizedToMultilineTailBuffer(
  previousLines: string[],
  boundedPreviousPartialLine: string,
  normalizedChunk: string,
  previousPartialWasCapped: boolean,
  previousRedrawCursor: RetainedTailRedrawCursor | null
): {
  lines: string[]
  partialLine: string
  redrawCursor: RetainedTailRedrawCursor | null
  truncated: boolean
  newCompleteLines: number
  newlyCompletedLines: string[]
} {
  const windowRows =
    maxUpwardCursorReach(normalizedChunk, previousRedrawCursor) + REDRAW_WINDOW_SAFETY_ROWS
  if (windowRows >= previousLines.length) {
    const unwindowed = appendNormalizedToMultilineTailBufferUnwindowed(
      previousLines,
      boundedPreviousPartialLine,
      normalizedChunk,
      previousPartialWasCapped,
      previousRedrawCursor
    )
    if (unwindowed.lines === previousLines) {
      return unwindowed
    }
    // Why nothing carries: an unwindowed redraw may rewrite any retained row. Both caps were
    // already applied inside the unwindowed builder, so the constructor only registers here.
    return {
      ...unwindowed,
      lines: buildCarriedTailLines(previousLines, 0, 0, unwindowed.lines, null).lines
    }
  }
  const prefixLength = previousLines.length - windowRows
  const suffix = previousLines.slice(prefixLength)
  const windowed = appendNormalizedToMultilineTailBufferUnwindowed(
    suffix,
    boundedPreviousPartialLine,
    normalizedChunk,
    previousPartialWasCapped,
    previousRedrawCursor
  )
  // The window provably cannot reach the prefix, so it carries unchanged — unless the tail
  // entered un-right-trimmed, in which case the prefix has to be rewritten to match the
  // unwindowed finalize's trailing-space trim and is therefore no longer the previous tail's rows.
  const previousStats = getRetainedTailLineStats(previousLines)
  let keepEnd = prefixLength
  let appended: readonly string[] = windowed.lines
  if (!previousStats.rightTrimmed) {
    const rewritten = previousLines.slice(0, prefixLength)
    for (let index = 0; index < rewritten.length; index += 1) {
      const line = rewritten[index]!
      const lastChar = line.charCodeAt(line.length - 1)
      if (lastChar === 32 || lastChar === 9) {
        rewritten[index] = line.replace(/[ \t]+$/g, '')
      }
    }
    for (const line of windowed.lines) {
      rewritten.push(line)
    }
    keepEnd = 0
    appended = rewritten
  }
  const built = buildCarriedTailLines(
    previousLines,
    0,
    keepEnd,
    appended,
    windowed.partialLine.length
  )
  return {
    lines: built.lines,
    partialLine: windowed.partialLine,
    redrawCursor: windowed.redrawCursor,
    truncated: windowed.truncated || built.truncated,
    newCompleteLines: windowed.newCompleteLines,
    newlyCompletedLines: windowed.newlyCompletedLines
  }
}
