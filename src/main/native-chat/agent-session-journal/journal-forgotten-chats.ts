import { deleteJournalDomainChatRowsPage } from './journal-domain-import-discard'
import { journalForkAttachmentHeld, journalForkStageHeld } from './journal-fork-stage-state'
import type Database from '../../sqlite/sync-database'

// Written with the record's deletion, so a crash before every page ran still finishes the rows.
// The chat's `journal.legacy-revision:` key stays, so the older journal never brings it back.
const FORGOTTEN_CHAT_KEY = 'journal.forgotten-chat:'

/**
 * True while the journal shows the chat in use: a fork holds it, input waits or is queued, or the
 * user sent or the agent ran since `idleBefore`.
 */
export function journalChatBusy(
  db: Database.Database,
  sessionId: string,
  idleBefore: number
): boolean {
  if (journalForkStageHeld(db, sessionId) || journalForkAttachmentHeld(db, sessionId)) {
    return true
  }
  const activity = db
    .prepare(`SELECT MAX(COALESCE((SELECT last_activity_at FROM journal_chat_state WHERE session_id=?1),0),
      COALESCE((SELECT MAX(last_activity_at) FROM journal_provider_activity WHERE session_id=?1),0),
      COALESCE((SELECT MAX(submitted_at) FROM journal_submission_attempts WHERE session_id=?1),0)) AS at`)
    .get(sessionId)
  return (
    Number(activity?.at ?? 0) > idleBefore ||
    !!db
      .prepare(`SELECT 1 FROM journal_submission_attempts
        WHERE session_id=? AND current=1 AND dispatch_state='pending' LIMIT 1`)
      .get(sessionId) ||
    // Queued text the user has not sent yet.
    !!db
      .prepare(`SELECT 1 FROM journal_queue_cards
        WHERE session_id=? AND state IN ('waiting','returned') LIMIT 1`)
      .get(sessionId)
  )
}

export function markJournalChatForgotten(db: Database.Database, sessionId: string): void {
  db.prepare('INSERT OR REPLACE INTO agent_session_store_meta (key, value) VALUES (?, ?)').run(
    `${FORGOTTEN_CHAT_KEY}${sessionId}`,
    '1'
  )
}

/** Forgotten chats whose rows are still being deleted, after `after` in id order. */
export function readForgottenJournalChats(db: Database.Database, after: string | null): string[] {
  return db
    .prepare(`SELECT substr(key,?1) AS session_id FROM agent_session_store_meta
      WHERE key>?2 AND key<?3 ORDER BY key LIMIT 16`)
    .all(
      FORGOTTEN_CHAT_KEY.length + 1,
      `${FORGOTTEN_CHAT_KEY}${after ?? ''}`,
      `${FORGOTTEN_CHAT_KEY.slice(0, -1)};`
    )
    .map((row) => String(row.session_id))
}

/** One page of a forgotten chat's rows; its head row goes last, in the page that finds none left. */
export function discardForgottenJournalChatPage(
  db: Database.Database,
  sessionId: string
): { kind: 'chat-discard'; more: boolean } {
  if (!db.isTransaction) {
    throw new Error('forgotten chat discard requires its writer transaction')
  }
  const key = `${FORGOTTEN_CHAT_KEY}${sessionId}`
  if (!db.prepare('SELECT 1 FROM agent_session_store_meta WHERE key=?').get(key)) {
    return { kind: 'chat-discard', more: false }
  }
  // A record under this id again (an older Orca's copy came back) owns these rows.
  if (db.prepare('SELECT 1 FROM agent_session_records WHERE session_id=?').get(sessionId)) {
    db.prepare('DELETE FROM agent_session_store_meta WHERE key=?').run(key)
    return { kind: 'chat-discard', more: false }
  }
  // A fork copying from or into it keeps the rows until the next sweep.
  if (journalForkStageHeld(db, sessionId) || journalForkAttachmentHeld(db, sessionId)) {
    return { kind: 'chat-discard', more: false }
  }
  if (deleteJournalDomainChatRowsPage(db, sessionId)) {
    return { kind: 'chat-discard', more: true }
  }
  db.prepare('DELETE FROM journal_chat_state WHERE session_id=?').run(sessionId)
  db.prepare('DELETE FROM agent_session_store_meta WHERE key=?').run(key)
  return { kind: 'chat-discard', more: false }
}
