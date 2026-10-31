import type Database from '../../sqlite/sync-database'
import { createJournalReducerState, type JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import {
  advanceJournalOutcomeSource,
  journalOutcomeSource,
  startJournalOutcomeLog
} from './journal-outcome-format'
import { persistJournalOutcomeRows } from './journal-outcome-table'

/** Every write stores outcome records, and nothing else: they are the saved chat. An input-only epoch
 * keeps its rows as they are and starts its records here, after them. */
export function prepareJournalOutcomeWrite(
  db: Database.Database,
  live: JournalReducerState,
  rows: readonly JournalRow[],
  savedAt: number
): { adopt: () => JournalReducerState } {
  const source =
    journalOutcomeSource(db, live.sessionId, live.epoch) ??
    startJournalOutcomeLog(db, live.sessionId, live.epoch, live.lastSequence, savedAt)
  if (source.through !== live.lastSequence) {
    throw new Error('journal outcome writer has stale coverage')
  }
  const transition = persistJournalOutcomeRows(db, live, source, rows, savedAt)
  advanceJournalOutcomeSource(db, live.sessionId, live.epoch, transition.state.lastSequence)
  return { adopt: transition.adopt }
}

/** Epoch builders use the same transition encoder; the epoch's journal rows hold only its marker. */
export function publishJournalOutcomeEpoch(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  rows: readonly JournalRow[]
): { adopt: () => JournalReducerState } {
  const first = rows[0]
  if (!first || first.seq !== 1 || first.kind !== 'epoch') {
    throw new Error('missing founding epoch')
  }
  const source = startJournalOutcomeLog(db, sessionId, epoch, 0, first.ts)
  const initial = createJournalReducerState(sessionId, epoch)
  const transition = persistJournalOutcomeRows(db, initial, source, rows)
  advanceJournalOutcomeSource(db, sessionId, epoch, transition.state.lastSequence)
  return { adopt: transition.adopt }
}
