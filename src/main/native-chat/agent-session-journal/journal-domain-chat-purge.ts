import { JOURNAL_EPOCH_TABLES } from './journal-domain-maintenance'
import { journalForkStageHeld } from './journal-fork-stage-state'
import { deleteJournalSessionRowsPage } from './journal-domain-import-discard'
import type Database from '../../sqlite/sync-database'

// Rows keyed by session alone; the chat-state head goes last so a crash mid-purge stays resumable.
const CHAT_TABLES = [
  { name: 'agent_session_command_receipts', key: 'operation_id,caller_key' },
  { name: 'agent_session_attachment_claims', key: 'upload_id' },
  { name: 'journal_chat_state', key: '' }
] as const

/** Delete one bounded page of a forgotten chat's rows; a chat that still has a record is left alone. */
export function purgeJournalDomainChatPage(
  db: Database.Database,
  sessionId: string
): { more: boolean } {
  if (!db.isTransaction) {
    throw new Error('journal chat purge requires its writer transaction')
  }
  const recorded = db
    .prepare('SELECT 1 AS present FROM agent_session_records WHERE session_id=?')
    .get(sessionId)
  if (recorded || journalForkStageHeld(db, sessionId)) {
    return { more: false }
  }
  const more =
    deleteJournalSessionRowsPage(db, sessionId, JOURNAL_EPOCH_TABLES) ||
    deleteJournalSessionRowsPage(db, sessionId, CHAT_TABLES, false)
  return { more }
}
