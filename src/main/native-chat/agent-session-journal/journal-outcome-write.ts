import type Database from '../../sqlite/sync-database'
import { createJournalReducerState, type JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import {
  advanceJournalOutcomeSource,
  journalOutcomeSource,
  startJournalOutcomeLog
} from './journal-outcome-format'
import { persistJournalOutcomeRows } from './journal-outcome-table'
import { journalCacheMatches, writeJournalOutcomeCache } from './journal-outcome-cache'
import { writeJournalProjectionSavepoint } from './journal-saved-state'

/** Every write stores outcome records. An input-only epoch keeps its rows as they are and starts its
 * records here, after them. `current` is false only when a cache that should follow the records
 * lags or its savepoint failed; a chat with an input prefix keeps main's open path and no cache. */
export function prepareJournalOutcomeWrite(
  db: Database.Database,
  live: JournalReducerState,
  rows: readonly JournalRow[],
  savedAt: number
): { adopt: () => JournalReducerState; current: boolean } {
  const source =
    journalOutcomeSource(db, live.sessionId, live.epoch) ??
    startJournalOutcomeLog(db, live.sessionId, live.epoch, live.lastSequence, savedAt)
  if (source.through !== live.lastSequence) {
    throw new Error('journal outcome writer has stale coverage')
  }
  const transition = persistJournalOutcomeRows(db, live, source, rows, savedAt)
  advanceJournalOutcomeSource(db, live.sessionId, live.epoch, transition.state.lastSequence)
  if (source.prefix > 0) {
    return { adopt: transition.adopt, current: true }
  }
  let cached = false
  const recovered = writeJournalProjectionSavepoint(db, live.sessionId, () => {
    // The stamp decides: a cache being rebuilt or left behind is never written past its gap.
    if (journalCacheMatches(db, live.sessionId, live.epoch, source)) {
      writeJournalOutcomeCache(db, transition.state, source.generation, transition.values)
      cached = true
    }
  })
  return { adopt: transition.adopt, current: cached && recovered }
}

/** Epoch builders use the same transition encoder; the epoch's journal rows hold only its marker. */
export function publishJournalOutcomeEpoch(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  rows: readonly JournalRow[]
): { adopt: () => JournalReducerState; through: number } {
  const first = rows[0]
  if (!first || first.seq !== 1 || first.kind !== 'epoch') {
    throw new Error('missing founding epoch')
  }
  const source = startJournalOutcomeLog(db, sessionId, epoch, 0, first.ts)
  const initial = createJournalReducerState(sessionId, epoch)
  const transition = persistJournalOutcomeRows(db, initial, source, rows)
  advanceJournalOutcomeSource(db, sessionId, epoch, transition.state.lastSequence)
  const cached = writeJournalProjectionSavepoint(db, sessionId, () =>
    writeJournalOutcomeCache(db, transition.state, source.generation, transition.values)
  )
  return { adopt: transition.adopt, through: cached ? transition.state.lastSequence : 0 }
}
