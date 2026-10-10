// Loading a journal: the session projection names the live epoch, and that
// epoch's rows are folded through the reducer in sequence order.
//
// There is no snapshot to anchor to and no superseded-epoch rows to drop — a
// roll deletes them in the same transaction that publishes the new epoch. A row
// this build cannot parse, a gap, or a first row that is not the epoch's is
// damage, and a row a newer Orca wrote is one this build cannot place: the load
// names either and the open fails on it. Nothing is deleted.

import type Database from '../../sqlite/sync-database'
import {
  applyJournalRow,
  createJournalReducerState,
  type JournalReducerState
} from './journal-reducer'
import {
  iterateJournalEpochRows,
  readJournalRowsAfter,
  readJournalSessionEpoch
} from './journal-row-table'
import { parseJournalRow, type JournalRow } from './journal-row-schema'

/** Every epoch row is sequence 1, and no compaction moves that floor. */
const FIRST_JOURNAL_SEQUENCE = 1

/** Where a journal stops being one this build can read as written. */
export type JournalDamage = {
  /** The first sequence that is missing, or not what the rows before it promise. */
  sequence: number
  cause: 'unparseable-row' | 'misnumbered-row' | 'sequence-gap' | 'no-epoch-row'
}

export type JournalLoad = {
  state: JournalReducerState
  /** The first row a newer Orca wrote: a future row version, or a row kind this build does not
   *  know. Only an update opens the chat. */
  newer: { sequence: number } | null
  /** Set when the history is damaged; a newer build's row wins over damage beside it. */
  damage: JournalDamage | null
}

/** Replays one chat from the host's database. Returns null when the chat has no journal yet. */
export function replayJournal(db: Database.Database, sessionId: string): JournalLoad | null {
  const epoch = readJournalSessionEpoch(db, sessionId)
  if (epoch === null) {
    return null
  }
  const fold = startJournalRowFold({ sessionId, epoch })
  for (const entry of iterateJournalEpochRows(db, sessionId, epoch)) {
    if (!fold.add(entry)) {
      break
    }
  }
  return fold.finish()
}

/** The same fold, fed a row at a time, for a caller that yields between batches of rows. */
export function startJournalRowFold(input: { sessionId: string; epoch: string }): {
  /** False once the fold has stopped: the rest of the rows are not read. */
  add: (entry: { seq: number; rowJson: string }) => boolean
  finish: () => JournalLoad
} {
  const state = createJournalReducerState(input.sessionId, input.epoch)
  let expectedSequence = FIRST_JOURNAL_SEQUENCE
  let damage: JournalDamage | null = null
  let anchored = false
  let newer: { sequence: number } | null = null
  let empty = true

  const add = (entry: { seq: number; rowJson: string }): boolean => {
    empty = false
    const parsed = parseJournalRow(entry.rowJson)
    if (!parsed.ok && parsed.unreadable) {
      newer = { sequence: entry.seq }
      return false
    }
    // Damage is read past, so a newer build's row further on still says to update.
    if (!parsed.ok) {
      damage ??= { sequence: entry.seq, cause: 'unparseable-row' }
      return true
    }
    // A body naming another sequence than its key: writes would number past the key.
    if (parsed.row.seq !== entry.seq) {
      damage ??= { sequence: entry.seq, cause: 'misnumbered-row' }
      return true
    }
    if (damage) {
      return true
    }
    const row = parsed.row
    if (row.seq !== expectedSequence) {
      const cause = expectedSequence === FIRST_JOURNAL_SEQUENCE ? 'no-epoch-row' : 'sequence-gap'
      damage = { sequence: expectedSequence, cause }
      return true
    }
    expectedSequence += 1
    if (row.seq === FIRST_JOURNAL_SEQUENCE && row.kind !== 'epoch') {
      damage = { sequence: row.seq, cause: 'no-epoch-row' }
      return true
    }
    anchored = true
    applyJournalRow(state, row)
    return true
  }
  const finish = (): JournalLoad => {
    state.oldestSequence = FIRST_JOURNAL_SEQUENCE
    // An epoch with no rows at all holds nothing to lose: the open founds a fresh one over it.
    const found =
      damage ??
      (anchored || empty
        ? null
        : { sequence: FIRST_JOURNAL_SEQUENCE, cause: 'no-epoch-row' as const })
    return { state, newer, damage: newer ? null : found }
  }
  return { add, finish }
}

/** `readJournalRowsAfterCursor` over one epoch, for a reader that supplies only the sequence. */
export function journalRowsAfterReader(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  limit?: number
): (afterSequence: number) => JournalRow[] {
  return (afterSequence) => readJournalRowsAfterCursor(db, sessionId, epoch, afterSequence, limit)
}

/** Rows after a cursor, in sequence order. Stops at the first row this build cannot parse: rows
 *  past it are never served. */
export function readJournalRowsAfterCursor(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  afterSequence: number,
  limit?: number
): JournalRow[] {
  const rows: JournalRow[] = []
  for (const stored of readJournalRowsAfter(db, sessionId, epoch, afterSequence, limit)) {
    const parsed = parseJournalRow(stored.rowJson)
    if (!parsed.ok) {
      break
    }
    rows.push(parsed.row)
  }
  return rows
}
