import {
  hasCanonicalNumericCsiParams,
  parseAnsiControlSequence
} from './terminal-ansi-normalization'
import type { RetainedTailRedrawCursor } from './terminal-tail-redraw-buffer'

// Reuse synchronous, non-reentrant scans' regex and reset lastIndex; constructing per TUI chunk adds allocation.
const CURSOR_UP_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[(\\d*)(?:;[\\d;]*)?A`, 'g')

function summedUpwardCursorReach(
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

// Repeated frames revisit the same rows; net cursor reach avoids summing CUUs into a false unwindowed fallback.
function netUpwardCursorReach(
  normalizedChunk: string,
  previousRedrawCursor: RetainedTailRedrawCursor | null
): number {
  let rowFromEnd = previousRedrawCursor ? previousRedrawCursor.rowFromEnd : 0
  let reach = rowFromEnd
  for (let index = 0; index < normalizedChunk.length; index += 1) {
    const code = normalizedChunk.charCodeAt(index)
    if (code === 0x0a) {
      rowFromEnd -= 1
      continue
    }
    if (code !== 0x1b) {
      continue
    }
    const parsed = parseAnsiControlSequence(normalizedChunk, index)
    if (!parsed) {
      continue
    }
    index = parsed.endIndex
    if (
      parsed.kind === 'csi' &&
      parsed.final === 'A' &&
      hasCanonicalNumericCsiParams(parsed.params)
    ) {
      rowFromEnd += parsed.firstParam ?? 1
      if (rowFromEnd > reach) {
        reach = rowFromEnd
      }
    }
  }
  return reach
}

export function maxUpwardCursorReach(
  normalizedChunk: string,
  previousRedrawCursor: RetainedTailRedrawCursor | null,
  windowLimit: number
): number {
  const summed = summedUpwardCursorReach(normalizedChunk, previousRedrawCursor)
  // The cheap sum is already an upper bound; only pay for the exact scan when it could still window.
  return summed < windowLimit || windowLimit <= 0
    ? summed
    : netUpwardCursorReach(normalizedChunk, previousRedrawCursor)
}
