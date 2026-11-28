import type SyncDatabase from '../../sqlite/sync-database'
import type { TranscriptMessage } from '../../ai-vault/transcripts/session-transcript-consumers'
import { identifierShadowText } from './session-search-identifier-split'

const CHUNK_TARGET_CHARS = 8000

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

/** Chunk conversation text for FTS ranking; tool output is not indexed. */
export function* searchMessageRows(
  messages: Iterable<TranscriptMessage>
): Generator<TranscriptMessage> {
  for (const message of messages) {
    if (message.role === 'tool') {
      continue
    }
    for (const text of textChunks(message.text)) {
      yield { ...message, text }
    }
  }
}

type InsertMessageStatements = {
  insertMessage: ReturnType<SyncDatabase['prepare']>
  insertFts: ReturnType<SyncDatabase['prepare']>
}

type DeleteMessageStatements = {
  selectMessageIds: ReturnType<SyncDatabase['prepare']>
  deleteFts: ReturnType<SyncDatabase['prepare']>
  deleteMessage: ReturnType<SyncDatabase['prepare']>
}

// Reuse compiled sqlite3_stmt handles per database to avoid native statement churn across thousands of indexed messages.
const insertStatementsByDb = new WeakMap<SyncDatabase, InsertMessageStatements>()
const deleteStatementsByDb = new WeakMap<SyncDatabase, DeleteMessageStatements>()

/** Insert metadata and FTS content together in the caller’s transaction. */
export function insertSearchMessage(
  db: SyncDatabase,
  sessionId: number,
  message: TranscriptMessage
): void {
  let stmts = insertStatementsByDb.get(db)
  if (!stmts) {
    stmts = {
      insertMessage: db.prepare(
        'INSERT INTO messages(session_row_id, role, ts, text_truncated) VALUES (?, ?, ?, ?)'
      ),
      insertFts: db.prepare(
        'INSERT INTO messages_fts(rowid,user_text,assistant_text,tool_text,identifiers) VALUES (?,?,?,?,?)'
      )
    }
    insertStatementsByDb.set(db, stmts)
  }
  const text = message.text
  const id = stmts.insertMessage.run(
    sessionId,
    message.role,
    message.timestamp,
    message.textTruncated ? 1 : 0
  ).lastInsertRowid
  const user = message.role === 'user' ? text : ''
  const assistant = message.role === 'assistant' ? text : ''
  const tool = message.role === 'tool' ? text : ''
  stmts.insertFts.run(id, user, assistant, tool, identifierShadowText(text))
}

/** Delete matching metadata and FTS rows in the caller’s transaction; limit retention work per step. */
export function deleteSearchMessages(db: SyncDatabase, sessionId: number, limit = -1): number {
  let stmts = deleteStatementsByDb.get(db)
  if (!stmts) {
    stmts = {
      selectMessageIds: db.prepare('SELECT id FROM messages WHERE session_row_id = ? LIMIT ?'),
      deleteFts: db.prepare('DELETE FROM messages_fts WHERE rowid = ?'),
      deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?')
    }
    deleteStatementsByDb.set(db, stmts)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT id FROM messages returns rows with numeric id.
  const ids = stmts.selectMessageIds.all(sessionId, limit) as { id: number }[]
  for (const { id } of ids) {
    stmts.deleteFts.run(id)
    stmts.deleteMessage.run(id)
  }
  return ids.length
}
