import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type SyncDatabase from '../sqlite/sync-database'
import { EMPTY_CONTENT_HASH, type SessionContentHash } from './session-search-content-hash'
import { redactSessionSearchText } from './session-search-redaction'
import { sessionSearchPathKey } from './session-search-path-key'

export class SessionSearchFileRecords {
  constructor(private readonly db: SyncDatabase) {}
  createStagingSession(candidate: SessionFileCandidate): number {
    return Number(
      this.db
        .prepare(`INSERT INTO sessions(index_ready,agent,session_id,file_path,title,resume_command)
      VALUES (0,?,'',?,'','')`)
        .run(candidate.agent, candidate.file.path).lastInsertRowid
    )
  }

  contentHash(rowId: number): SessionContentHash {
    const row = this.db
      .prepare('SELECT content_hash, content_hash_count FROM sessions WHERE id = ?')
      .get(rowId) as { content_hash: string | null; content_hash_count: number } | undefined
    return row ? { hash: row.content_hash, count: row.content_hash_count } : EMPTY_CONTENT_HASH
  }

  updateSession(session: AiVaultSession, rowId: number, contentHash: SessionContentHash): void {
    const values = [
      session.agent,
      session.sessionId,
      session.filePath,
      session.codexHome,
      redactSessionSearchText(session.title),
      session.cwd,
      session.cwd ? sessionSearchPathKey(session.cwd, session.filePath) : null,
      session.branch,
      session.createdAt,
      session.updatedAt,
      session.messageCount,
      session.resumeCommand,
      contentHash.hash,
      contentHash.count
    ]
    this.db
      .prepare(`UPDATE sessions SET agent = ?, session_id = ?, file_path = ?, codex_home = ?, title = ?,
        cwd = ?, cwd_key = ?, branch = ?, created_at = ?, updated_at = ?, message_count = ?, resume_command = ?,
        content_hash = ?, content_hash_count = ? WHERE id = ?`)
      .run(...values, rowId)
  }

  upsertFile(
    candidate: SessionFileCandidate,
    byteOffset: number,
    sessionRowId: number | null
  ): void {
    const { file } = candidate
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
        byteOffset,
        file.mtimeMs,
        file.sizeBytes ?? null,
        sessionRowId
      )
  }
}
