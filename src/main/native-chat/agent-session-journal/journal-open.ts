// Replay live epochs without rewriting history; damage/newer rows fail load and remain on disk.

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

const FIRST_JOURNAL_SEQUENCE = 1

export type JournalDamage = {
  sequence: number
  cause: 'unparseable-row' | 'misnumbered-row' | 'sequence-gap' | 'no-epoch-row'
}

export type JournalLoad = {
  state: JournalReducerState
  /** Future row versions/kinds require an updated reader. */
  newer: { sequence: number } | null
  /** Newer content outranks adjacent damage. */
  damage: JournalDamage | null
}

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

export function startJournalRowFold(input: { sessionId: string; epoch: string }): {
  add: (entry: { seq: number; rowJson: string; ts?: number }) => boolean
  finish: () => JournalLoad
} {
  const state = createJournalReducerState(input.sessionId, input.epoch)
  let expectedSequence = FIRST_JOURNAL_SEQUENCE
  let damage: JournalDamage | null = null
  let anchored = false
  let newer: { sequence: number } | null = null
  let empty = true

  const add = (entry: { seq: number; rowJson: string; ts?: number }): boolean => {
    empty = false
    const parsed = parseJournalRow(entry.rowJson)
    if (!parsed.ok && parsed.unreadable) {
      newer = { sequence: entry.seq }
      return false
    }
    // Continue past damage to discover later rows requiring a newer reader.
    if (!parsed.ok) {
      damage ??= { sequence: entry.seq, cause: 'unparseable-row' }
      return true
    }
    // Key/body sequence mismatches would make future writes number against the wrong prefix.
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
    applyJournalRow(state, row, entry.ts)
    return true
  }
  const finish = (): JournalLoad => {
    state.oldestSequence = FIRST_JOURNAL_SEQUENCE
    // Empty epochs contain no recoverable history; founding a fresh epoch loses nothing.
    const found =
      damage ??
      (anchored || empty
        ? null
        : { sequence: FIRST_JOURNAL_SEQUENCE, cause: 'no-epoch-row' as const })
    return { state, newer, damage: newer ? null : found }
  }
  return { add, finish }
}

export function journalRowsAfterReader(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  limit?: number
): (afterSequence: number) => JournalRow[] {
  return (afterSequence) => readJournalRowsAfterCursor(db, sessionId, epoch, afterSequence, limit)
}

/** Stop replay at the first unreadable row; never serve a partial tail beyond it. */
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
