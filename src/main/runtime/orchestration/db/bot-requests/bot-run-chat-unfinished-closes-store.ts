// Closed run chats whose moves to their bot's Home Chat have yet to finish: queued messages, Runs,
// and the senders of mail it never read. Kept here, not in memory, so a restart between a run
// chat's close and those moves still finds what it left.
import type { OrchestrationDb } from '../orchestration-db'

export const BOT_RUN_CHAT_UNFINISHED_CLOSES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bot_run_chat_unfinished_closes (
  session_id TEXT PRIMARY KEY,
  bot_id     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

/** Written before the close, so a crash after it still leaves the record. */
export function recordUnfinishedRunChatClose(
  db: OrchestrationDb,
  botId: string,
  sessionId: string
): void {
  db.db
    .prepare(
      'INSERT OR IGNORE INTO bot_run_chat_unfinished_closes (session_id, bot_id) VALUES (?, ?)'
    )
    .run(sessionId, botId)
}

/** Every move finished, or the close it was written for did not happen. */
export function forgetUnfinishedRunChatClose(db: OrchestrationDb, sessionId: string): void {
  db.db.prepare('DELETE FROM bot_run_chat_unfinished_closes WHERE session_id = ?').run(sessionId)
}

export function unfinishedRunChatCloses(db: OrchestrationDb, botId: string): string[] {
  return db.db
    .prepare(
      'SELECT session_id FROM bot_run_chat_unfinished_closes WHERE bot_id = ? ORDER BY created_at'
    )
    .all(botId)
    .map((row) => String(row.session_id))
}
