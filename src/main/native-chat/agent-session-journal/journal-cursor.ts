// Cursors from replaced epochs require a fresh snapshot; partial replay would mix timelines.

import type {
  AgentJournalCursor,
  AgentJournalResetReason
} from '../../../shared/agent-session-journal-types'
import type { JournalReadSince } from './journal-store-contracts'
import type { JournalRow } from './journal-row-schema'

export type JournalCursorRange = {
  epoch: string
  lastSequence: number
  /** Earliest individually replayable sequence. */
  oldestSequence: number
}

export type JournalResume =
  | { ok: true; afterSequence: number }
  | { ok: false; reset: AgentJournalResetReason }

export function sameJournalCursor(a: AgentJournalCursor, b: AgentJournalCursor): boolean {
  return a.epoch === b.epoch && a.sequence === b.sequence
}

/** Reload snapshots for epoch mismatches, rolled-back prefixes or compacted cursors. */
export function resolveJournalResume(
  range: JournalCursorRange,
  cursor: AgentJournalCursor
): JournalResume {
  if (cursor.epoch !== range.epoch) {
    return { ok: false, reset: 'epoch_changed' }
  }
  if (cursor.sequence > range.lastSequence) {
    return { ok: false, reset: 'cursor_ahead' }
  }
  // The boundary cursor already includes snapshot-folded rows and may resume from the tail.
  if (cursor.sequence < range.oldestSequence - 1) {
    return { ok: false, reset: 'cursor_compacted' }
  }
  return { ok: true, afterSequence: cursor.sequence }
}

/** Gaps invalidate replay; never render a partial timeline. */
export function findSequenceGap(
  sequences: readonly number[],
  expectedFirst: number
): { gapAt: number } | null {
  let expected = expectedFirst
  for (const sequence of sequences) {
    if (sequence !== expected) {
      return { gapAt: expected }
    }
    expected += 1
  }
  return null
}

export function readJournalSince(
  source: {
    state: { epoch: string; lastSequence: number; oldestSequence: number }
    rowsAfter: (afterSequence: number) => JournalRow[]
  },
  cursor: AgentJournalCursor,
  currentCursor: () => AgentJournalCursor
): JournalReadSince {
  const resume = resolveJournalResume(source.state, cursor)
  if (!resume.ok) {
    return { ok: false, reset: resume.reset }
  }
  return {
    ok: true,
    rows: source.rowsAfter(resume.afterSequence),
    cursor: currentCursor()
  }
}
