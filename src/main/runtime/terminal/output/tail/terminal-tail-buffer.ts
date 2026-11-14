import { containsTerminalVerticalLineControl } from '../terminal-ansi-normalization'
import { ownRetainedString } from '../../../../../shared/own-retained-string'
import { getRetainedTailLineStats, buildCarriedTailLines } from './terminal-tail-retention'
import {
  applyTerminalLineControls,
  processTerminalTailCompleteSegments,
  splitRetainedTerminalTailSegments,
  trimTerminalLineRight
} from './terminal-tail-line-controls'
import { MAX_TAIL_PARTIAL_CHARS } from './terminal-tail-limits'
import { maxUpwardCursorReach } from './terminal-tail-redraw-reach'
import {
  appendNormalizedToMultilineTailBufferUnwindowed,
  type RetainedTailRedrawCursor
} from './terminal-tail-redraw-buffer'
import {
  getTerminalLineOrigins,
  setTerminalLineOrigins,
  sliceTerminalOrigins,
  writeTerminalOrigins,
  type TerminalOriginRuns
} from '../../../../../shared/terminal/output/terminal-content-origin'

export function appendNormalizedToTailBuffer(
  previousLines: string[],
  previousPartialLine: string,
  normalizedChunk: string,
  previousRedrawCursor: RetainedTailRedrawCursor | null = null,
  origins?: { partial: TerminalOriginRuns; chunk: TerminalOriginRuns }
): {
  lines: string[]
  partialLine: string
  redrawCursor: RetainedTailRedrawCursor | null
  truncated: boolean
  newCompleteLines: number
  newlyCompletedLines: string[]
  partialOrigins?: TerminalOriginRuns
} {
  if (normalizedChunk.length === 0) {
    return {
      lines: previousLines,
      partialLine: previousPartialLine,
      redrawCursor: previousRedrawCursor,
      truncated: false,
      newCompleteLines: 0,
      newlyCompletedLines: [],
      ...(origins ? { partialOrigins: origins.partial } : {})
    }
  }

  // Why: fullscreen TUIs emit long newline-free redraw streams; keep the line transcript for pagination but bound partial-line work.
  const previousPartialWasCapped = previousPartialLine.length > MAX_TAIL_PARTIAL_CHARS
  const boundedPreviousPartialLine = previousPartialLine.slice(-MAX_TAIL_PARTIAL_CHARS)
  const combinedChunk = `${boundedPreviousPartialLine}${normalizedChunk}`
  const combinedOrigins = origins
    ? writeTerminalOrigins(
        sliceTerminalOrigins(
          origins.partial,
          Math.max(0, previousPartialLine.length - MAX_TAIL_PARTIAL_CHARS)
        ),
        boundedPreviousPartialLine.length,
        combinedChunk.length,
        origins.chunk
      )
    : undefined
  if (previousRedrawCursor || containsTerminalVerticalLineControl(combinedChunk)) {
    return appendNormalizedToMultilineTailBuffer(
      previousLines,
      boundedPreviousPartialLine,
      normalizedChunk,
      previousPartialWasCapped,
      previousRedrawCursor,
      origins
        ? {
            partial: sliceTerminalOrigins(
              origins.partial,
              Math.max(0, previousPartialLine.length - MAX_TAIL_PARTIAL_CHARS)
            ),
            chunk: origins.chunk
          }
        : undefined
    )
  }

  // Why: status UIs redraw one line via CR/backspace/erase; retain the latest redraw segment instead of appending every spinner frame.
  const segments = splitRetainedTerminalTailSegments(combinedChunk)
  let segmentOffset =
    combinedChunk.length -
    segments.partialSegment.length -
    segments.completeSegments.reduce((sum, segment) => sum + segment.length + 1, 0)
  const segmentOrigins = combinedOrigins
    ? segments.completeSegments.map((segment) => {
        const kept = sliceTerminalOrigins(
          combinedOrigins,
          segmentOffset,
          segmentOffset + segment.length
        )
        segmentOffset += segment.length + 1
        return kept
      })
    : undefined
  const pieces = processTerminalTailCompleteSegments(segments.completeSegments, segmentOrigins)
  const newlyCompletedLines: string[] = []
  for (const piece of pieces) {
    // Why own: every retained row is sliced from this chunk but outlives it by up to
    // MAX_TAIL_LINES chunks, so an un-owned row pins its whole 64 KiB chunk.
    newlyCompletedLines.push(ownRetainedString(trimTerminalLineRight(piece)))
  }
  const pieceOrigins = getTerminalLineOrigins(pieces)
  if (pieceOrigins) {
    setTerminalLineOrigins(
      newlyCompletedLines,
      pieceOrigins.map((runs, index) =>
        newlyCompletedLines[index]!.length === pieces[index]!.length
          ? runs
          : sliceTerminalOrigins(runs, 0, newlyCompletedLines[index]!.length)
      )
    )
  }
  const partialResult = applyTerminalLineControls(
    segments.partialSegment,
    combinedOrigins
      ? sliceTerminalOrigins(combinedOrigins, combinedChunk.length - segments.partialSegment.length)
      : undefined
  )
  const nextPartialLine = trimTerminalLineRight(partialResult.text)
  const retainedPartialLine = ownRetainedString(nextPartialLine.slice(-MAX_TAIL_PARTIAL_CHARS))
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
    newlyCompletedLines,
    ...(origins
      ? {
          partialOrigins: sliceTerminalOrigins(
            partialResult.origins,
            Math.max(0, nextPartialLine.length - MAX_TAIL_PARTIAL_CHARS),
            nextPartialLine.length
          )
        }
      : {})
  }
}

// Redraw reaches only a suffix; window it and share untouched rows to avoid O(tail) work per TUI chunk (retained-tail-redraw-window.equivalence.test.ts).
const REDRAW_WINDOW_SAFETY_ROWS = 8

function appendNormalizedToMultilineTailBuffer(
  previousLines: string[],
  boundedPreviousPartialLine: string,
  normalizedChunk: string,
  previousPartialWasCapped: boolean,
  previousRedrawCursor: RetainedTailRedrawCursor | null,
  origins?: { partial: TerminalOriginRuns; chunk: TerminalOriginRuns }
): {
  lines: string[]
  partialLine: string
  redrawCursor: RetainedTailRedrawCursor | null
  truncated: boolean
  newCompleteLines: number
  newlyCompletedLines: string[]
  partialOrigins?: TerminalOriginRuns
} {
  const windowRows =
    maxUpwardCursorReach(
      normalizedChunk,
      previousRedrawCursor,
      previousLines.length - REDRAW_WINDOW_SAFETY_ROWS
    ) + REDRAW_WINDOW_SAFETY_ROWS
  if (windowRows >= previousLines.length) {
    const unwindowed = appendNormalizedToMultilineTailBufferUnwindowed(
      previousLines,
      boundedPreviousPartialLine,
      normalizedChunk,
      previousPartialWasCapped,
      previousRedrawCursor,
      origins
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
  const previousOrigins = getTerminalLineOrigins(previousLines)
  if (previousOrigins) {
    setTerminalLineOrigins(suffix, previousOrigins.slice(prefixLength))
  }
  const windowed = appendNormalizedToMultilineTailBufferUnwindowed(
    suffix,
    boundedPreviousPartialLine,
    normalizedChunk,
    previousPartialWasCapped,
    previousRedrawCursor,
    origins
  )
  // Carry the unreachable prefix only when already right-trimmed; otherwise rewrite it to match unwindowed finalization.
  const previousStats = getRetainedTailLineStats(previousLines)
  let keepEnd = prefixLength
  let appended: readonly string[] = windowed.lines
  if (!previousStats.rightTrimmed) {
    const rewritten = previousLines.slice(0, prefixLength)
    for (let index = 0; index < rewritten.length; index += 1) {
      const line = rewritten[index]!
      const lastChar = line.charCodeAt(line.length - 1)
      if (lastChar === 32 || lastChar === 9) {
        rewritten[index] = trimTerminalLineRight(line)
      }
    }
    for (const line of windowed.lines) {
      rewritten.push(line)
    }
    keepEnd = 0
    appended = rewritten
    if (origins) {
      setTerminalLineOrigins(rewritten, [
        ...rewritten
          .slice(0, prefixLength)
          .map((line, index) => sliceTerminalOrigins(previousOrigins?.[index], 0, line.length)),
        ...(getTerminalLineOrigins(windowed.lines) ?? windowed.lines.map(() => []))
      ])
    }
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
    newlyCompletedLines: windowed.newlyCompletedLines,
    ...(origins ? { partialOrigins: windowed.partialOrigins ?? [] } : {})
  }
}
