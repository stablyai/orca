import type SyncDatabase from '../sqlite/sync-database'
import type { TranscriptMessage } from '../ai-vault/session-transcript-consumers'
import { sliceAtCodeUnitLimit } from '../ai-vault/session-scanner-text-normalization'
import { identifierShadowText } from './session-search-identifier-split'

const CHUNK_TARGET_CHARS = 8000

// Cap tool-output prefixes to keep logs from dominating index size; retain all conversation text.
const TOOL_ROW_CHARS = 3072

// Folded diacritics remain inside tokens; see sqlite3Fts5UnicodeIsdiacritic in fts5_unicode2.c.
const FOLDED_DIACRITIC =
  /[\u0300-\u0304\u0306-\u030c\u030f\u0311\u031b\u0323-\u0328\u032d-\u032e\u0330-\u0331]/
const TOKEN_BOUNDARY = /[^\p{L}\p{N}\p{Co}_.\-/+\uD800-\uDFFF]/u

function lastTokenBoundaryEnd(text: string, floor: number, end: number): number {
  for (let at = end - 1; at >= floor; at--) {
    if (TOKEN_BOUNDARY.test(text[at]!) && !FOLDED_DIACRITIC.test(text[at]!)) {
      return at + 1
    }
  }
  return -1
}

/** Prefer token boundaries; phrases spanning separate FTS rows cannot match. */
function* textChunks(text: string): Generator<string> {
  if (text.length <= CHUNK_TARGET_CHARS) {
    yield text
    return
  }
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_TARGET_CHARS)
    if (end < text.length) {
      // Search only the latter half to avoid tiny chunks; hard-cut if no boundary exists there.
      const split = lastTokenBoundaryEnd(text, start + CHUNK_TARGET_CHARS / 2, end)
      if (split > start) {
        end = split
      }
    }
    yield text.slice(start, end)
    start = end
  }
}

/** Chunk conversation text for FTS ranking; tool output gets one capped row. */
export function* searchMessageRows(
  messages: Iterable<TranscriptMessage>
): Generator<TranscriptMessage> {
  for (const message of messages) {
    if (message.role === 'tool') {
      const text = sliceAtCodeUnitLimit(message.text, TOOL_ROW_CHARS)
      yield {
        ...message,
        text,
        ...(text.length < message.text.length ? { textTruncated: true as const } : {})
      }
      continue
    }
    for (const text of textChunks(message.text)) {
      yield { ...message, text }
    }
  }
}

/** Insert metadata and FTS content together in the caller’s transaction. */
export function insertSearchMessage(
  db: SyncDatabase,
  sessionId: number,
  message: TranscriptMessage
): void {
  const text = message.text
  const id = db
    .prepare('INSERT INTO messages(session_row_id, role, ts, text_truncated) VALUES (?, ?, ?, ?)')
    .run(sessionId, message.role, message.timestamp, message.textTruncated ? 1 : 0).lastInsertRowid
  const user = message.role === 'user' ? text : ''
  const assistant = message.role === 'assistant' ? text : ''
  const tool = message.role === 'tool' ? text : ''
  db.prepare(
    'INSERT INTO messages_fts(rowid,user_text,assistant_text,tool_text,identifiers) VALUES (?,?,?,?,?)'
  ).run(id, user, assistant, tool, identifierShadowText(text))
}

/** Delete matching metadata and FTS rows in the caller’s transaction; limit retention work per step. */
export function deleteSearchMessages(db: SyncDatabase, sessionId: number, limit = -1): number {
  const ids = db
    .prepare('SELECT id FROM messages WHERE session_row_id = ? LIMIT ?')
    .all(sessionId, limit) as { id: number }[]
  const full = db.prepare('DELETE FROM messages_fts WHERE rowid = ?')
  const message = db.prepare('DELETE FROM messages WHERE id = ?')
  for (const { id } of ids) {
    full.run(id)
    message.run(id)
  }
  return ids.length
}
