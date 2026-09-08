import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchCapturedMessage } from '../ai-vault/session-search-capture'
import { identifierShadowText } from './session-search-identifier-split'

const CHUNK_TARGET_CHARS = 8000

function* textChunks(text: string): Generator<string> {
  if (text.length <= CHUNK_TARGET_CHARS) {
    yield text
    return
  }
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_TARGET_CHARS)
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end)
      if (newline > start + CHUNK_TARGET_CHARS / 2) {
        end = newline + 1
      }
    }
    yield text.slice(start, end)
    start = end
  }
}

export function* searchMessageRows(
  messages: Iterable<SessionSearchCapturedMessage>
): Generator<SessionSearchCapturedMessage> {
  for (const message of messages) {
    for (const text of textChunks(message.text)) {
      yield { ...message, text }
    }
  }
}

export function insertSearchMessage(
  db: SyncDatabase,
  sessionId: number,
  batchId: number,
  message: SessionSearchCapturedMessage
): void {
  const id = db
    .prepare('INSERT INTO messages(session_row_id, batch_id, role, ts) VALUES (?, ?, ?, ?)')
    .run(sessionId, batchId, message.role, message.timestamp).lastInsertRowid
  const user = message.role === 'user' ? message.text : ''
  const assistant = message.role === 'assistant' ? message.text : ''
  const tool = message.role === 'tool' ? message.text : ''
  db.prepare(
    'INSERT INTO messages_fts(rowid,user_text,assistant_text,tool_text,identifiers) VALUES (?,?,?,?,?)'
  ).run(id, user, assistant, tool, identifierShadowText(message.text))
  if (message.role !== 'tool') {
    db.prepare('INSERT INTO conversation_fts(rowid,user_text,assistant_text) VALUES (?,?,?)').run(
      id,
      user,
      assistant
    )
  }
}

export function chunkMessageText(text: string): string[] {
  return [...textChunks(text)]
}
