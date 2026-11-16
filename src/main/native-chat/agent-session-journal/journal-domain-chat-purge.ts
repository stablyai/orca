import { JOURNAL_EPOCH_TABLES } from './journal-domain-maintenance'
import { journalForkAttachmentHeld, journalForkStageHeld } from './journal-fork-stage-state'
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
  // A fork copying this chat holds its rows until the copy settles.
  if (recorded || journalForkStageHeld(db, sessionId) || journalForkAttachmentHeld(db, sessionId)) {
    return { more: false }
  }
  const more =
    deleteJournalSessionRowsPage(db, sessionId, JOURNAL_EPOCH_TABLES) ||
    deleteJournalSessionRowsPage(db, sessionId, CHAT_TABLES, false)
  return { more }
}

/** One page, after `after`, of chats whose record is gone but whose journal remains: a purge cut short. */
export function listJournalDomainOrphanChats(
  db: Database.Database,
  after: string
): {
  orphans: { sessionId: string; workspaceId: string }[]
  next: string | null
} {
  const rows = db
    .prepare(
      `SELECT c.session_id AS session_id, c.workspace_id AS workspace_id FROM journal_chat_state c
       WHERE c.session_id > ?
         AND NOT EXISTS (SELECT 1 FROM agent_session_records r WHERE r.session_id = c.session_id)
       ORDER BY c.session_id LIMIT 256`
    )
    .all(after)
  const last = rows.at(-1)?.session_id
  return {
    // Kept or held rows still advance the cursor, so later orphans are reached.
    next: rows.length === 256 && typeof last === 'string' ? last : null,
    orphans: rows.flatMap((row) =>
      typeof row.session_id === 'string' &&
      typeof row.workspace_id === 'string' &&
      !journalForkStageHeld(db, row.session_id) &&
      !journalForkAttachmentHeld(db, row.session_id)
        ? [{ sessionId: row.session_id, workspaceId: row.workspace_id }]
        : []
    )
  }
}
