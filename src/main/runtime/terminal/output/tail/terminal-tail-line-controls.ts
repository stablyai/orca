import {
  hasCanonicalNumericCsiParams,
  parseAnsiControlSequence
} from '../terminal-ansi-normalization'
import { MAX_TAIL_CHARS, MAX_TAIL_LINES, MAX_TAIL_PARTIAL_CHARS } from './terminal-tail-limits'
import {
  sliceTerminalOrigins,
  writeTerminalOrigins,
  setTerminalLineOrigins,
  type TerminalOriginRuns
} from '../../../../../shared/terminal/output/terminal-content-origin'

export function trimTerminalLineRight(line: string): string {
  let end = line.length
  while (end > 0) {
    const code = line.charCodeAt(end - 1)
    if (code !== 0x20 && code !== 0x09) {
      break
    }
    end -= 1
  }
  return end === line.length ? line : line.slice(0, end)
}

export function splitRetainedTerminalTailSegments(value: string): {
  completeSegments: string[]
  partialSegment: string
  completeLineCount: number
} {
  let completeLineCount = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\n') {
      completeLineCount += 1
    }
  }

  const retainedCompleteCount = Math.min(completeLineCount, MAX_TAIL_LINES)
  const omittedCompleteCount = completeLineCount - retainedCompleteCount
  let startIndex = 0
  if (omittedCompleteCount > 0) {
    let seen = 0
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] !== '\n') {
        continue
      }
      seen += 1
      if (seen === omittedCompleteCount) {
        startIndex = index + 1
        break
      }
    }
  }

  const completeSegments: string[] = []
  let segmentStart = startIndex
  for (let index = startIndex; index < value.length; index += 1) {
    if (value[index] !== '\n') {
      continue
    }
    completeSegments.push(value.slice(segmentStart, index))
    segmentStart = index + 1
  }

  return {
    completeSegments,
    partialSegment: value.slice(segmentStart),
    completeLineCount
  }
}

export function processTerminalTailCompleteSegments(
  segments: string[],
  origins?: readonly TerminalOriginRuns[]
): string[] {
  const processed: string[] = []
  const processedOrigins: TerminalOriginRuns[] = []
  let totalChars = 0
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const result = applyTerminalLineControls(segments[index]!, origins?.[index])
    const line = result.text
    processed.push(line)
    processedOrigins.push(result.origins ?? [])
    totalChars += line.length
    if (totalChars > MAX_TAIL_CHARS) {
      break
    }
  }
  processed.reverse()
  if (origins) {
    setTerminalLineOrigins(processed, processedOrigins.toReversed())
  }
  return processed
}

export function applyTerminalLineControls(
  line: string,
  origins?: TerminalOriginRuns
): {
  text: string
  cursorColumn: number
  hadControl: boolean
  origins?: TerminalOriginRuns
} {
  const carriageIndex = line.lastIndexOf('\r')
  const latestRedraw = carriageIndex !== -1 ? line.slice(carriageIndex + 1) : line
  if (!latestRedraw.includes('\u0008') && !latestRedraw.includes('\u001b')) {
    return {
      text: latestRedraw,
      cursorColumn: latestRedraw.length,
      hadControl: carriageIndex !== -1,
      ...(origins ? { origins: sliceTerminalOrigins(origins, carriageIndex + 1) } : {})
    }
  }

  const chars: string[] = []
  let keptOrigins: TerminalOriginRuns = []
  const sourceOrigins = sliceTerminalOrigins(origins, carriageIndex + 1)
  let cursor = 0
  const moveCursorTo = (nextCursor: number): void => {
    cursor = clampTerminalPreviewCursor(nextCursor)
  }
  const writeChar = (char: string, at: number): void => {
    if (cursor > chars.length) {
      const oldLength = chars.length
      chars.length = cursor
      chars.fill(' ', oldLength, cursor)
    }
    if (cursor >= chars.length) {
      chars.push(char)
    } else {
      chars[cursor] = char
    }
    if (origins) {
      keptOrigins = writeTerminalOrigins(
        keptOrigins,
        cursor,
        cursor + 1,
        sliceTerminalOrigins(sourceOrigins, at, at + 1)
      )
    }
    cursor += 1
  }
  for (let index = 0; index < latestRedraw.length; index += 1) {
    const char = latestRedraw[index]
    if (char === '\u0008') {
      if (cursor > 0) {
        cursor -= 1
      }
    } else if (char === '\u001b') {
      const parsed = parseAnsiControlSequence(latestRedraw, index)
      if (!parsed) {
        continue
      }
      index = parsed.endIndex
      if (parsed.kind !== 'csi') {
        continue
      }
      if (!hasCanonicalNumericCsiParams(parsed.params)) {
        continue
      }
      if (parsed.final === 'K') {
        const mode = parsed.firstParam ?? 0
        if (mode === 0) {
          chars.length = cursor
          keptOrigins = sliceTerminalOrigins(keptOrigins, 0, cursor)
        } else if (mode === 1) {
          const deleteCount = Math.min(cursor + 1, chars.length)
          chars.fill(' ', 0, deleteCount)
          keptOrigins = writeTerminalOrigins(keptOrigins, 0, deleteCount)
        } else if (mode === 2) {
          chars.length = 0
          keptOrigins = []
        }
      } else if (parsed.final === 'G' || parsed.final === '`') {
        moveCursorTo((parsed.firstParam ?? 1) - 1)
      } else if (parsed.final === 'D') {
        cursor = Math.max(0, cursor - (parsed.firstParam ?? 1))
      } else if (parsed.final === 'C') {
        moveCursorTo(cursor + (parsed.firstParam ?? 1))
      }
    } else {
      writeChar(char, index)
    }
  }
  return {
    text: chars.join(''),
    cursorColumn: cursor,
    hadControl: true,
    ...(origins ? { origins: keptOrigins } : {})
  }
}

export function clampTerminalPreviewCursor(nextCursor: number): number {
  if (!Number.isFinite(nextCursor)) {
    return MAX_TAIL_PARTIAL_CHARS
  }
  return Math.min(MAX_TAIL_PARTIAL_CHARS, Math.max(0, Math.floor(nextCursor)))
}
