import { isDeepStrictEqual } from 'node:util'
// Loading a journal: the session projection names the live epoch, and that
// epoch's rows are folded through the reducer in sequence order.
//
// There is no snapshot to anchor to and no superseded-epoch rows to drop — a
// roll deletes them in the same transaction that publishes the new epoch. A row
// this build cannot parse, a strict-prefix gap, or a first row that is not the epoch's is
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
  state.replayTextDebt = new Map()
  let expectedSequence = FIRST_JOURNAL_SEQUENCE
  let damage: JournalDamage | null = null
  let anchored = false
  let newer: { sequence: number } | null = null
  let empty = true

  const add = (entry: { seq: number; rowJson: string; ts?: number }): boolean => {
    empty = false
    const parsed = parseJournalRow(entry.rowJson, true)
    if (!parsed.ok && parsed.unreadable) {
      newer = { sequence: entry.seq }
      return false
    }
    // Continue past damage to discover later rows requiring a newer reader.
    if (!parsed.ok) {
      damage ??= { sequence: entry.seq, cause: 'unparseable-row' }
      return true
    }
    // A body naming another sequence than its key: writes would number past the key.
    if (parsed.row.seq !== entry.seq || parsed.row.epoch !== input.epoch) {
      damage ??= { sequence: entry.seq, cause: 'misnumbered-row' }
      return true
    }
    if (damage) {
      return true
    }
    const row = parsed.row
    if (
      row.seq < expectedSequence ||
      (row.seq !== expectedSequence && state.textIndex.sparseAfter === null)
    ) {
      const cause = expectedSequence === FIRST_JOURNAL_SEQUENCE ? 'no-epoch-row' : 'sequence-gap'
      damage = { sequence: expectedSequence, cause }
      return true
    }
    expectedSequence = row.seq + 1
    if (row.seq === FIRST_JOURNAL_SEQUENCE && row.kind !== 'epoch') {
      damage = { sequence: row.seq, cause: 'no-epoch-row' }
      return true
    }
    anchored = true
    try {
      applyJournalRow(state, row, entry.ts)
    } catch {
      damage = { sequence: row.seq, cause: 'unparseable-row' }
    }
    return true
  }
  const finish = (): JournalLoad => {
    state.oldestSequence = FIRST_JOURNAL_SEQUENCE
    // An epoch with no rows at all holds nothing to lose: the open founds a fresh one over it.
    for (const sequence of state.replayTextDebt?.values() ?? []) {
      if (!damage || sequence < damage.sequence) {
        damage = { sequence, cause: 'unparseable-row' }
      }
    }
    state.replayTextDebt = null
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
    const parsed = parseJournalRow(stored.rowJson, true)
    if (!parsed.ok || parsed.row.seq !== stored.seq || parsed.row.epoch !== epoch) {
      break
    }
    rows.push(parsed.row)
  }
  return rows
}

export function preserveJournalLiveText(
  state: JournalReducerState,
  loaded: JournalLoad
): JournalReducerState {
  if (state.epoch === loaded.state.epoch) {
    for (const [key, policy] of state.textPolicy) {
      if (
        isDeepStrictEqual(state.items.get(key), loaded.state.items.get(key)) &&
        state.itemFences.get(key) === loaded.state.itemFences.get(key) &&
        state.itemExecutionOwners.get(key) === loaded.state.itemExecutionOwners.get(key)
      ) {
        loaded.state.textPolicy.set(key, policy)
      }
    }
  }
  return loaded.state
}
