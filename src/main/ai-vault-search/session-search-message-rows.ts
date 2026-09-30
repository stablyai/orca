import type SyncDatabase from '../sqlite/sync-database'
import type { TranscriptMessage } from '../ai-vault/session-transcript-consumers'
import { sliceAtCodeUnitLimit } from '../ai-vault/session-scanner-text-normalization'
import { identifierShadowText } from './session-search-identifier-split'

const CHUNK_TARGET_CHARS = 8000

/**
 * How much of one tool output is indexed. Its head: a command, its arguments and
 * the first lines of what it printed are what a user searches for, while the
 * tail is the padding that makes these messages large in the first place.
 *
 * Tool output is 80-97 % of a transcript's bytes, and a single one can be a
 * quarter of a megabyte (the reader's own per-message bound). Without this the
 * index, the in-memory buffer a read holds and the transaction it commits are
 * all sized by how much a tool printed rather than by how much is worth
 * searching. 3 KB was the accuracy/size sweet spot in the original design
 * measurement. User and assistant text is never capped: it is the conversation,
 * and it is small.
 */
const TOOL_ROW_CHARS = 3072

// Keep unicode61's tokenchars intact, including before an available space.
// SQLite ext/fts5/fts5_unicode2.c: sqlite3Fts5UnicodeIsdiacritic, with remove_diacritics=1.
const FOLDED_DIACRITIC =
  /[\u0300-\u0304\u0306-\u030c\u030f\u0311\u031b\u0323-\u0328\u032d-\u032e\u0330-\u0331]/
const TOKEN_BOUNDARY = /[^\p{L}\p{N}\p{Co}_.\-/+\uD800-\uDFFF]/u

/**
 * Index just past the last token boundary in `[floor, end)`, or -1 when the
 * window holds none. Not only a newline: a wrapped paragraph, a CJK transcript
 * separated by ideographic spaces and a minified log all chunk on a boundary a
 * tokenizer would have picked anyway.
 */
function lastTokenBoundaryEnd(text: string, floor: number, end: number): number {
  for (let at = end - 1; at >= floor; at--) {
    if (TOKEN_BOUNDARY.test(text[at]!) && !FOLDED_DIACRITIC.test(text[at]!)) {
      return at + 1
    }
  }
  return -1
}

/**
 * Splits an oversized message into rows of at most `CHUNK_TARGET_CHARS`, cutting
 * on a token boundary so no token is torn in half and every word stays
 * searchable. A phrase that straddles two chunks is not matched: chunks are
 * separate FTS rows and FTS5 cannot span them.
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
      // torn token for chunks half the size. No boundary at all in 4,000
      // characters is not a word, so the target itself is the honest cut.
      const split = lastTokenBoundaryEnd(text, start + CHUNK_TARGET_CHARS / 2, end)
      if (split > start) {
        end = split
      }
    }
    yield text.slice(start, end)
    start = end
  }
}

/**
 * The row policy for one message: a `tool` message becomes one capped row, and
 * anything else becomes N chunks, because FTS5 ranks a short row far better
 * than a huge one.
 */
export function* searchMessageRows(
  messages: Iterable<TranscriptMessage>
): Generator<TranscriptMessage> {
  for (const message of messages) {
    if (message.role === 'tool') {
      yield {
        ...message,
        text: sliceAtCodeUnitLimit(message.text, TOOL_ROW_CHARS)
      }
      continue
    }
    for (const text of textChunks(message.text)) {
      yield { ...message, text }
    }
  }
}

/**
 * Writes one row into `messages` and `messages_fts` in the caller's
 * transaction, so a message is never present in one and absent from the other.
 * A conversation-scoped query filters the columns rather than reading a second
 * table (see the schema).
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
}

/**
 * Deletes up to `limit` of a session's rows from `messages` and `messages_fts`,
 * in the caller's transaction, and reports how many went. Bounded
 * because a retention sweep must not hold one transaction over a whole
 * session; a replace passes no limit, since its rows and their replacements
 * have to land together.
 */
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
