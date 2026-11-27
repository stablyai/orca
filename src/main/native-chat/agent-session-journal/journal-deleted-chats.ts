// A deleted chat's tombstone, written in the commit that forgets its records and kept for good: Orca
// never lists, resumes or adopts its agent conversations again. The transcripts stay the CLI's own.
import type Database from '../../sqlite/sync-database'
import type { DeletedChat } from '../chat-deletion/deleted-chats'

const DELETED_CHAT_KEY = 'chat.deleted:'

export function writeDeletedChat(db: Database.Database, chat: DeletedChat): void {
  db.prepare('INSERT OR REPLACE INTO agent_session_store_meta (key, value) VALUES (?, ?)').run(
    `${DELETED_CHAT_KEY}${chat.chatId}`,
    JSON.stringify(chat)
  )
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')

function isDeletedChat(value: unknown): value is DeletedChat {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const chat: Partial<Record<keyof DeletedChat, unknown>> = value
  return (
    typeof chat.chatId === 'string' &&
    isStringArray(chat.sessionIds) &&
    Array.isArray(chat.conversations) &&
    chat.conversations.every(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        'provider' in entry &&
        typeof entry.provider === 'string' &&
        'providerSessionId' in entry &&
        typeof entry.providerSessionId === 'string'
    )
  )
}

/** Every tombstone; an unreadable row is skipped, never guessed at. */
export function readDeletedChats(db: Database.Database): DeletedChat[] {
  // A read-only open of a newer build's database may lack the table; it then holds no tombstones.
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_session_store_meta'")
      .get()
  ) {
    return []
  }
  return db
    .prepare('SELECT value FROM agent_session_store_meta WHERE key>=?1 AND key<?2')
    .all(DELETED_CHAT_KEY, `${DELETED_CHAT_KEY.slice(0, -1)};`)
    .flatMap((row) => {
      try {
        const value: unknown = JSON.parse(String(row.value))
        return isDeletedChat(value) ? [value] : []
      } catch {
        return []
      }
    })
}
