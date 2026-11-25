// The chats Orca started for a bot request (`--chat new`): written once the request was admitted into
// its new chat, never by a person's own chat, so a tidy can tell the two apart. Keyed by session id.
import type { OrchestrationDb } from '../orchestration-db'

export const BOT_REQUEST_CHATS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bot_request_chats (
  session_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

export function markBotRequestChat(db: Pick<OrchestrationDb, 'db'>, sessionId: string): void {
  db.db.prepare('INSERT OR IGNORE INTO bot_request_chats (session_id) VALUES (?)').run(sessionId)
}

/** Up to `limit` marked chats after `after`, in session id order (a primary key range). */
export function pageBotRequestChats(
  db: Pick<OrchestrationDb, 'db'>,
  after: string,
  limit: number
): string[] {
  return db.db
    .prepare(
      'SELECT session_id FROM bot_request_chats WHERE session_id > ? ORDER BY session_id LIMIT ?'
    )
    .all(after, limit)
    .flatMap((row: unknown) =>
      row && typeof row === 'object' && 'session_id' in row && typeof row.session_id === 'string'
        ? [row.session_id]
        : []
    )
}

export function isMarkedBotRequestChat(
  db: Pick<OrchestrationDb, 'db'>,
  sessionId: string
): boolean {
  return (
    db.db.prepare('SELECT 1 FROM bot_request_chats WHERE session_id = ?').get(sessionId) !==
    undefined
  )
}
