import type SyncDatabase from '../sqlite/sync-database'
import type {
  SessionSearchFileIdentity,
  SessionSearchIndexedFile,
  SessionSearchIndexUpdate
} from '../ai-vault/session-search-capture'
import {
  EMPTY_CONTENT_HASH,
  foldContentHash,
  type SessionContentHash
} from './session-search-content-hash'
import { identifierShadowText } from './session-search-identifier-split'

// Why: FTS5's length normalization buries a 100 KB tool log even when it holds
// the query many times; chunks at line boundaries keep every row rankable.
const CHUNK_TARGET_CHARS = 8000

type FileRow = {
  dev: number | null
  ino: number | null
  byte_offset: number
  mtime_ms: number
  size_bytes: number | null
  session_row_id: number | null
}

export function chunkMessageText(text: string): string[] {
  if (text.length <= CHUNK_TARGET_CHARS) {
    return [text]
  }
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_TARGET_CHARS)
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end)
      if (newline > start + CHUNK_TARGET_CHARS / 2) {
        end = newline + 1
      }
    }
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}

export class SessionSearchIndexWriter {
  constructor(private readonly db: SyncDatabase) {}

  indexedFile(path: string, identity: SessionSearchFileIdentity): SessionSearchIndexedFile | null {
    const row = this.db
      .prepare(
        'SELECT dev, ino, byte_offset, mtime_ms, size_bytes, session_row_id FROM files WHERE path = ?'
      )
      .get(path) as FileRow | undefined
    if (!row) {
      return null
    }
    if (identity && row.dev !== null && row.ino !== null) {
      if (row.dev !== identity.dev || row.ino !== identity.ino) {
        return null
      }
    }
    return { byteOffset: row.byte_offset, mtimeMs: row.mtime_ms, sizeBytes: row.size_bytes }
  }

  apply(update: SessionSearchIndexUpdate): void {
    const path = update.candidate.file.path
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db
        .prepare('SELECT byte_offset, session_row_id FROM files WHERE path = ?')
        .get(path) as Pick<FileRow, 'byte_offset' | 'session_row_id'> | undefined
      const appendable =
        update.mode === 'append' &&
        existing !== undefined &&
        existing.byte_offset === update.previousByteOffset &&
        existing.session_row_id !== null
      if (!appendable) {
        this.deleteFile(path, existing?.session_row_id ?? null)
      }
      // Why: an append that does not continue from the stored offset (a racing
      // parse advanced it) would leave a hole; drop the file so the next parse
      // is whole instead of storing a partial session.
      if (update.mode === 'append' && !appendable) {
        this.db.exec('COMMIT')
        return
      }
      if (update.session === null) {
        this.upsertFile(update, null)
        this.db.exec('COMMIT')
        return
      }
      const rowId = appendable ? existing.session_row_id : null
      const sessionRowId = this.upsertSession(
        update,
        rowId,
        foldContentHash(
          rowId === null ? EMPTY_CONTENT_HASH : this.contentHash(rowId),
          update.messages
        )
      )
      this.insertMessages(sessionRowId, update)
      this.upsertFile(update, sessionRowId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  removeFile(path: string): void {
    const existing = this.db
      .prepare('SELECT session_row_id FROM files WHERE path = ?')
      .get(path) as Pick<FileRow, 'session_row_id'> | undefined
    if (!existing) {
      return
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.deleteFile(path, existing.session_row_id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private deleteFile(path: string, sessionRowId: number | null): void {
    if (sessionRowId !== null) {
      const ids = this.db
        .prepare('SELECT id FROM messages WHERE session_row_id = ?')
        .all(sessionRowId) as { id: number }[]
      const deleteFts = this.db.prepare('DELETE FROM messages_fts WHERE rowid = ?')
      const deleteConversation = this.db.prepare('DELETE FROM conversation_fts WHERE rowid = ?')
      for (const { id } of ids) {
        deleteFts.run(id)
        deleteConversation.run(id)
      }
      this.db.prepare('DELETE FROM messages WHERE session_row_id = ?').run(sessionRowId)
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionRowId)
    }
    this.db.prepare('DELETE FROM files WHERE path = ?').run(path)
  }

  private contentHash(rowId: number): SessionContentHash {
    const row = this.db
      .prepare('SELECT content_hash, content_hash_count FROM sessions WHERE id = ?')
      .get(rowId) as { content_hash: string | null; content_hash_count: number } | undefined
    return row ? { hash: row.content_hash, count: row.content_hash_count } : EMPTY_CONTENT_HASH
  }

  private upsertSession(
    update: SessionSearchIndexUpdate,
    rowId: number | null,
    contentHash: SessionContentHash
  ): number {
    const session = update.session!
    const values = [
      session.agent,
      session.sessionId,
      session.filePath,
      session.codexHome,
      session.title,
      session.cwd,
      session.branch,
      session.createdAt,
      session.updatedAt,
      session.messageCount,
      session.resumeCommand,
      contentHash.hash,
      contentHash.count
    ]
    if (rowId !== null) {
      this.db
        .prepare(
          `UPDATE sessions SET agent = ?, session_id = ?, file_path = ?, codex_home = ?, title = ?,
             cwd = ?, branch = ?, created_at = ?, updated_at = ?, message_count = ?, resume_command = ?,
             content_hash = ?, content_hash_count = ?
           WHERE id = ?`
        )
        .run(...values, rowId)
      return rowId
    }
    const result = this.db
      .prepare(
        `INSERT INTO sessions(agent, session_id, file_path, codex_home, title, cwd, branch,
           created_at, updated_at, message_count, resume_command, content_hash, content_hash_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(...values)
    return Number(result.lastInsertRowid)
  }

  private insertMessages(sessionRowId: number, update: SessionSearchIndexUpdate): void {
    const insertMessage = this.db.prepare(
      'INSERT INTO messages(session_row_id, role, ts) VALUES (?, ?, ?)'
    )
    const insertFts = this.db.prepare(
      'INSERT INTO messages_fts(rowid, user_text, assistant_text, tool_text, identifiers) VALUES (?, ?, ?, ?, ?)'
    )
    const insertConversation = this.db.prepare(
      'INSERT INTO conversation_fts(rowid, user_text, assistant_text) VALUES (?, ?, ?)'
    )
    for (const message of update.messages) {
      for (const chunk of chunkMessageText(message.text)) {
        const id = Number(
          insertMessage.run(sessionRowId, message.role, message.timestamp).lastInsertRowid
        )
        const user = message.role === 'user' ? chunk : ''
        const assistant = message.role === 'assistant' ? chunk : ''
        const tool = message.role === 'tool' ? chunk : ''
        insertFts.run(id, user, assistant, tool, identifierShadowText(chunk))
        if (message.role !== 'tool') {
          insertConversation.run(id, user, assistant)
        }
      }
    }
  }

  private upsertFile(update: SessionSearchIndexUpdate, sessionRowId: number | null): void {
    const { file } = update.candidate
    this.db
      .prepare(
        `INSERT INTO files(path, dev, ino, byte_offset, mtime_ms, size_bytes, session_row_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET dev = excluded.dev, ino = excluded.ino,
           byte_offset = excluded.byte_offset, mtime_ms = excluded.mtime_ms,
           size_bytes = excluded.size_bytes, session_row_id = excluded.session_row_id`
      )
      .run(
        file.path,
        file.dev ?? null,
        file.ino ?? null,
        update.byteOffset,
        file.mtimeMs,
        file.sizeBytes ?? null,
        sessionRowId
      )
  }
}
