// Closed run chats whose queued messages have yet to reach their bot's Home Chat. Kept here, not in
// memory, so a restart between a run chat's close and the move still finds what it left.
import type { OrchestrationDb } from '../orchestration-db'

export const BOT_RUN_CHAT_OWED_CARDS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bot_run_chat_owed_cards (
  session_id TEXT PRIMARY KEY,
  bot_id     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

/** Written before the close, so a crash after it still leaves the record. */
export function oweRunChatCards(db: OrchestrationDb, botId: string, sessionId: string): void {
  db.db
    .prepare('INSERT OR IGNORE INTO bot_run_chat_owed_cards (session_id, bot_id) VALUES (?, ?)')
    .run(sessionId, botId)
}

/** Its cards all moved, or the close it was written for did not happen. */
export function forgetOwedRunChatCards(db: OrchestrationDb, sessionId: string): void {
  db.db.prepare('DELETE FROM bot_run_chat_owed_cards WHERE session_id = ?').run(sessionId)
}

export function owedRunChatCards(db: OrchestrationDb, botId: string): string[] {
  return db.db
    .prepare('SELECT session_id FROM bot_run_chat_owed_cards WHERE bot_id = ? ORDER BY created_at')
    .all(botId)
    .map((row) => String(row.session_id))
}
