import type Database from '../../../sqlite/sync-database'
import type { JournalRow } from '../durable-rows/journal-row-schema'
import { createJournalReducerState } from '../projection/journal-reducer'
import { journalInputOrder } from '../input-order/journal-input-order'
import { advanceJournalOutcomeSource, startJournalOutcomeLog } from './journal-outcome-format'
import { persistJournalOutcomeRows } from './journal-outcome-table'

/** Seeds the frozen saved format for conversion tests. */
export function publishJournalOutcomeEpoch(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  rows: readonly JournalRow[]
) {
  const first = rows[0]
  if (!first || first.seq !== 1 || first.kind !== 'epoch') {
    throw new Error('missing founding epoch')
  }
  const source = startJournalOutcomeLog(db, sessionId, epoch, 0, first.ts)
  const transition = persistJournalOutcomeRows(
    db,
    createJournalReducerState(sessionId, epoch),
    source,
    rows,
    undefined,
    true,
    (state) => {
      journalInputOrder(state).restore(state)
      journalInputOrder(state).finishReconstruction(state)
    }
  )
  advanceJournalOutcomeSource(db, sessionId, epoch, transition.state.lastSequence)
  return { adopt: transition.adopt }
}
