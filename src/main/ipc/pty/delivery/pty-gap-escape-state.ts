/** Label the first delivery after a renderer-stream gap with the escape it resumes inside, so an abandoned restore can skip that tail (#33766). */
import { advanceTerminalEscapeBoundary } from '../../../../shared/terminal-partial-escape-tail'

// Escape-parser state at the end of each PTY's accepted output, delivered or dropped.
const escapeBoundaryByPty = new Map<string, string>()
const gapPendingPtys = new Set<string>()

/** Advance over an accepted payload; returns the state in effect before it. */
export function advancePtyEscapeBoundary(id: string, data: string): string {
  const before = escapeBoundaryByPty.get(id) ?? ''
  const after = advanceTerminalEscapeBoundary(before, data)
  if (after) {
    escapeBoundaryByPty.set(id, after)
  } else {
    escapeBoundaryByPty.delete(id)
  }
  return before
}

export function markPtyRendererStreamGap(id: string): void {
  gapPendingPtys.add(id)
}

/** The open escape a delivery resumes inside, once per gap; undefined when the stream resumes clean. */
export function takePtyGapEscapeState(id: string, stateBefore: string): string | undefined {
  if (!gapPendingPtys.delete(id)) {
    return undefined
  }
  return stateBefore || undefined
}

export function clearPtyGapEscapeState(id: string): void {
  escapeBoundaryByPty.delete(id)
  gapPendingPtys.delete(id)
}

export function _resetPtyGapEscapeStateForTest(): void {
  escapeBoundaryByPty.clear()
  gapPendingPtys.clear()
}
