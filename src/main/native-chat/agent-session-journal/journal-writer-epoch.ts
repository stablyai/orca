import type Database from '../../sqlite/sync-database'
import type { JournalReducerState } from './projection/journal-reducer'
import { journalInputOrder } from './input-order/journal-input-order'
import { journalInputAcceptance } from './input-order/journal-input-provenance'
import { JournalSqlReducer } from './journal-sql-reducer'
import { JournalSqlScope } from './journal-sql-scope'
import { exportJournalControlState } from './journal-sql-control-export'
import {
  beginJournalSqlConversion,
  markJournalSqlReady,
  readyJournalSqlEpoch
} from './journal-sql-meta'

/** A newly published epoch's state, small by construction, is written as that epoch's projection;
 *  the retired epoch's rows stay for the writer's batched sweep, as retired outcome generations do. */
export function publishJournalWriterEpoch(
  db: Database.Database,
  state: JournalReducerState,
  ownerToken: string,
  previous: () => JournalReducerState
): void {
  if (readyJournalSqlEpoch(db, state.sessionId) === null) {
    beginJournalSqlConversion(db, state.sessionId)
  } else {
    // As the host's adopt does: owed recovery follows ids still queued in the new epoch.
    journalInputOrder(state).carryRecovery(journalInputOrder(previous()))
  }
  const exported = new JournalSqlReducer(
    new JournalSqlScope(db, state.sessionId, state.epoch),
    state.epoch,
    (id) => journalInputAcceptance(db, state.sessionId, id)
  )
  exported.context.bulkLoad(() => {
    exportJournalControlState(state, exported.state, { items: true })
    exported.flush()
  })
  markJournalSqlReady(db, state.sessionId, ownerToken)
}
