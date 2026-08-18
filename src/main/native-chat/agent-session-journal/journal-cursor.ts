// Epoch-qualified cursor resume.
//
// A cursor is only meaningful inside its epoch: rollover invalidates every one
// of them, and the client takes a clean snapshot reload rather than being
// handed rows that belong to a rebuilt timeline.

import type {
  AgentJournalCursor,
  AgentJournalResetReason
} from '../../../shared/agent-session-journal-types'
import type { JournalReadSince } from './journal-store-contracts'
import type { JournalRow } from './journal-row-schema'

export type JournalCursorRange = {
  epoch: string
  /** Sequence of the newest appended row; 0 when the epoch is empty. */
  lastSequence: number
  /** Lowest sequence still individually replayable after compaction. */
  oldestSequence: number
}

export type JournalResume =
  /** Replay rows with `seq > afterSequence`. */
  { ok: true; afterSequence: number } | { ok: false; reset: AgentJournalResetReason }

/** Total order over cursors within one epoch; cross-epoch comparison is
 *  meaningless, so callers must check the epoch first. */
export function sameJournalCursor(a: AgentJournalCursor, b: AgentJournalCursor): boolean {
  return a.epoch === b.epoch && a.sequence === b.sequence
}

/**
 * Decide whether a reconnecting client can resume from `cursor`.
 *
 * An epoch mismatch, a cursor ahead of the journal (the client saw rows this
 * host no longer has — a rolled-back or rebuilt prefix), and a cursor below the
 * compaction floor all resolve to a snapshot reload. None of them is recoverable
 * by shipping a partial batch.
 */
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
  // `oldestSequence - 1` is the compaction boundary: a client sitting exactly on
  // it has seen everything folded into the snapshot and can take the tail.
  if (cursor.sequence < range.oldestSequence - 1) {
    return { ok: false, reset: 'cursor_compacted' }
  }
  return { ok: true, afterSequence: cursor.sequence }
}

/** Contiguity check over a replayed row sequence. A gap means the journal lost
 *  a row; the reader must treat it as corrupt and force epoch rollover rather
 *  than render a partial timeline. */
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

/** Rows appended after `cursor`, or the reset a client must take instead. A
 *  read-only journal always resets: this build cannot vouch for what it holds. */
export function readJournalSince(
  source: {
    state: { epoch: string; lastSequence: number; oldestSequence: number }
    tailRows: readonly JournalRow[]
    readOnly: boolean
  },
  cursor: AgentJournalCursor,
  currentCursor: () => AgentJournalCursor
): JournalReadSince {
  if (source.readOnly) {
    return { ok: false, reset: 'schema_unreadable' }
  }
  const resume = resolveJournalResume(source.state, cursor)
  if (!resume.ok) {
    return { ok: false, reset: resume.reset }
  }
  return {
    ok: true,
    rows: source.tailRows.filter((row) => row.seq > resume.afterSequence),
    cursor: currentCursor()
  }
}
