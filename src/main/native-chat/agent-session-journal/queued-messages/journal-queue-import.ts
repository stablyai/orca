import type Database from '../../../sqlite/sync-database'
import type { JournalReducerState } from '../projection/journal-reducer'
import type { QueuedMessageRow } from './queued-message-table'
import { legacyQueuedChange } from './journal-queue-legacy-change'
import { queuedCardFromChange } from './journal-queue-fold'
import { readStoredQueuedMessageRow } from './queued-message-stored-row'

export function readJournalLegacyCards(
  db: Database.Database,
  state: JournalReducerState
): QueuedMessageRow[] {
  return readLegacyRows(db, state.sessionId).flatMap((row) => {
    const change = legacyQueuedChange(state, row)
    return change ? [queuedCardFromChange(state, row.messageId, change)] : []
  })
}

function readLegacyRows(db: Database.Database, sessionId: string): QueuedMessageRow[] {
  return db
    .prepare('SELECT * FROM queued_messages WHERE session_id = ? ORDER BY position ASC')
    .all(sessionId)
    .flatMap((row) => readStoredQueuedMessageRow(row) ?? [])
}
