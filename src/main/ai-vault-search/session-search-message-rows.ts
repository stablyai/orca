import type SyncDatabase from '../sqlite/sync-database'
import type { TranscriptMessage } from '../ai-vault/session-transcript-consumers'
import { identifierShadowText } from './session-search-identifier-split'

const CHUNK_TARGET_CHARS = 8000

/**
 * Index just past the last whitespace in `[floor, end)`, or -1 when the window
 * holds none. Any Unicode whitespace, not only a newline: a wrapped paragraph, a
 * CJK transcript separated by ideographic spaces and a minified log all chunk on
 * a boundary a tokenizer would have picked anyway.
 */
function lastWhitespaceEnd(text: string, floor: number, end: number): number {
  for (let at = end - 1; at >= floor; at--) {
    if (/\s/.test(text[at]!)) {
      return at + 1
    }
  }
  return -1
}

/**
 * Splits an oversized message into rows of at most `CHUNK_TARGET_CHARS`, cutting
 * at whitespace so no token is torn in half and every word stays searchable.
 * A phrase that straddles two chunks is not matched: chunks are separate FTS
 * rows and FTS5 cannot span them.
 */
function* textChunks(text: string): Generator<string> {
  if (text.length <= CHUNK_TARGET_CHARS) {
    yield text
    return
  }
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_TARGET_CHARS)
    if (end < text.length) {
      // Only the second half of the window: backing up further would trade a
      // torn token for chunks half the size. No whitespace at all in 4,000
      // characters is not a word, so the target itself is the honest cut.
      const split = lastWhitespaceEnd(text, start + CHUNK_TARGET_CHARS / 2, end)
      if (split > start) {
        end = split
      }
    }
    yield text.slice(start, end)
    start = end
  }
}

/** One message becomes N rows: FTS5 ranks a short row far better than a huge one. */
export function* searchMessageRows(
  messages: Iterable<TranscriptMessage>
): Generator<TranscriptMessage> {
  for (const message of messages) {
    for (const text of textChunks(message.text)) {
      yield { ...message, text }
    }
  }
}

/**
 * Writes one row into `messages` and both FTS tables in the caller's
 * transaction, so a message is never present in one table and absent from the
 * other. `tool` rows stay out of `conversation_fts`: that table is the
 * conversation-only half of the split.
 */
export function insertSearchMessage(
  db: SyncDatabase,
  sessionId: number,
  message: TranscriptMessage
): void {
  const text = message.text
  const id = db
    .prepare('INSERT INTO messages(session_row_id, role, ts) VALUES (?, ?, ?)')
    .run(sessionId, message.role, message.timestamp).lastInsertRowid
  const user = message.role === 'user' ? text : ''
  const assistant = message.role === 'assistant' ? text : ''
  const tool = message.role === 'tool' ? text : ''
  db.prepare(
    'INSERT INTO messages_fts(rowid,user_text,assistant_text,tool_text,identifiers) VALUES (?,?,?,?,?)'
  ).run(id, user, assistant, tool, identifierShadowText(text))
  if (message.role !== 'tool') {
    db.prepare('INSERT INTO conversation_fts(rowid,user_text,assistant_text) VALUES (?,?,?)').run(
      id,
      user,
      assistant
    )
  }
}

/**
 * Deletes up to `limit` of a session's rows from `messages` and both FTS
 * tables, in the caller's transaction, and reports how many went. Bounded
 * because a retention sweep must not hold one transaction over a whole
 * session; a replace passes no limit, since its rows and their replacements
 * have to land together.
 */
export function deleteSearchMessages(db: SyncDatabase, sessionId: number, limit = -1): number {
  const ids = db
    .prepare('SELECT id FROM messages WHERE session_row_id = ? LIMIT ?')
    .all(sessionId, limit) as { id: number }[]
  const full = db.prepare('DELETE FROM messages_fts WHERE rowid = ?')
  const conversation = db.prepare('DELETE FROM conversation_fts WHERE rowid = ?')
  const message = db.prepare('DELETE FROM messages WHERE id = ?')
  for (const { id } of ids) {
    full.run(id)
    conversation.run(id)
    message.run(id)
  }
  return ids.length
}
