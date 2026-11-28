import {
  fileIdentity,
  PARTIAL_FILE_CURSOR,
  type SessionSearchFileIdentity,
  type SessionSearchIndexedFile
} from './session-search-file-cursor'
import type { AiVaultSession } from '../../../shared/ai-vault/contracts/ai-vault-types'
import type { TranscriptSessionIdentity } from '../../ai-vault/transcripts/session-transcript-consumers'
import type { SessionFileCandidate } from '../../ai-vault/session-scanner-types'
import type SyncDatabase from '../../sqlite/sync-database'
import { EMPTY_CONTENT_HASH, type SessionContentHash } from './session-search-content-hash'
import { normalizeRuntimePathForComparison } from '../../../shared/file-access/cross-platform-path'

/** Use the sidebar’s path normalization so indexed cwd keys join its folder groups. */
export function cwdKey(cwd: string | null): string | null {
  return cwd ? normalizeRuntimePathForComparison(cwd) : null
}

export type SessionSearchFileCursor = {
  session_row_id: number | null
  byte_offset: number
}

type FileRow = SessionSearchFileCursor & {
  dev: number | null
  ino: number | null
  mtime_ms: number
  size_bytes: number | null
}

export class SessionSearchFileRecords {
  private createSessionRowStmt: ReturnType<SyncDatabase['prepare']> | null = null
  private updateProvisionalStmt: ReturnType<SyncDatabase['prepare']> | null = null
  private contentHashStmt: ReturnType<SyncDatabase['prepare']> | null = null
  private updateSessionStmt: ReturnType<SyncDatabase['prepare']> | null = null
  private upsertFileStmt: ReturnType<SyncDatabase['prepare']> | null = null
  private indexedFileStmt: ReturnType<SyncDatabase['prepare']> | null = null
  private cursorStmt: ReturnType<SyncDatabase['prepare']> | null = null
  private deleteFileStmt: ReturnType<SyncDatabase['prepare']> | null = null
  private deleteSessionStmt: ReturnType<SyncDatabase['prepare']> | null = null

  constructor(private readonly db: SyncDatabase) {}

  close(): void {
    this.createSessionRowStmt = null
    this.updateProvisionalStmt = null
    this.contentHashStmt = null
    this.updateSessionStmt = null
    this.upsertFileStmt = null
    this.indexedFileStmt = null
    this.cursorStmt = null
    this.deleteFileStmt = null
    this.deleteSessionStmt = null
  }

  indexedFile(path: string, identity: SessionSearchFileIdentity): SessionSearchIndexedFile | null {
    this.indexedFileStmt ??= this.db.prepare(
      // REAL recovers the original numeric stat IDs, including existing oversized INTEGER rows.
      `SELECT CAST(dev AS REAL) AS dev, CAST(ino AS REAL) AS ino,
              byte_offset, mtime_ms, size_bytes, session_row_id FROM files WHERE path = ?`
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The files schema defines FileRow; REAL casts return numeric IDs or null.
    const row = this.indexedFileStmt.get(path) as FileRow | undefined
    if (!row) {
      return null
    }
    // Older indexes can carry half-pairs; only a complete identity can prove replacement.
    if (identity && row.dev !== null && row.ino !== null) {
      if (row.dev !== identity.dev || row.ino !== identity.ino) {
        return null
      }
    }
    return {
      byteOffset: row.byte_offset === PARTIAL_FILE_CURSOR ? null : row.byte_offset,
      mtimeMs: row.mtime_ms,
      sizeBytes: row.size_bytes
    }
  }

  cursor(path: string): SessionSearchFileCursor | undefined {
    this.cursorStmt ??= this.db.prepare(
      'SELECT session_row_id,byte_offset FROM files WHERE path = ?'
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: files schema defines session_row_id and byte_offset matching SessionSearchFileCursor.
    return this.cursorStmt.get(path) as SessionSearchFileCursor | undefined
  }

  deleteFile(path: string): void {
    this.deleteFileStmt ??= this.db.prepare('DELETE FROM files WHERE path = ?')
    this.deleteFileStmt.run(path)
  }

  deleteSession(sessionRowId: number): void {
    this.deleteSessionStmt ??= this.db.prepare('DELETE FROM sessions WHERE id = ?')
    this.deleteSessionStmt.run(sessionRowId)
  }

  createSessionRow(candidate: SessionFileCandidate): number {
    this.createSessionRowStmt ??= this.db.prepare(
      `INSERT INTO sessions(agent,session_id,file_path,title,resume_command)
      VALUES (?,'',?,'','')`
    )
    return Number(
      this.createSessionRowStmt.run(candidate.agent, candidate.file.path).lastInsertRowid
    )
  }

  /** Name each committed chunk immediately; the final decoded session replaces provisional metadata. */
  updateProvisionalSession(
    rowId: number,
    identity: TranscriptSessionIdentity,
    candidate: SessionFileCandidate
  ): void {
    this.updateProvisionalStmt ??= this.db.prepare(
      `UPDATE sessions SET session_id = ?, title = ?, cwd = ?, cwd_key = ?,
         created_at = ?, updated_at = ? WHERE id = ?`
    )
    this.updateProvisionalStmt.run(
      identity.sessionId,
      identity.title ?? '',
      identity.cwd,
      cwdKey(identity.cwd),
      identity.createdAt,
      identity.updatedAt ?? (candidate.agent === 'cursor' ? candidate.file.modifiedAt : null),
      rowId
    )
  }

  contentHash(rowId: number): SessionContentHash {
    this.contentHashStmt ??= this.db.prepare(
      'SELECT content_hash, content_hash_count FROM sessions WHERE id = ?'
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sessions schema defines content_hash and content_hash_count.
    const row = this.contentHashStmt.get(rowId) as
      | { content_hash: string | null; content_hash_count: number }
      | undefined
    return row ? { hash: row.content_hash, count: row.content_hash_count } : EMPTY_CONTENT_HASH
  }

  updateSession(session: AiVaultSession, rowId: number, contentHash: SessionContentHash): void {
    this.updateSessionStmt ??= this.db.prepare(
      `UPDATE sessions SET agent = ?, session_id = ?, file_path = ?, codex_home = ?, title = ?,
        cwd = ?, cwd_key = ?, branch = ?, created_at = ?, updated_at = ?, message_count = ?, resume_command = ?,
        content_hash = ?, content_hash_count = ? WHERE id = ?`
    )
    this.updateSessionStmt.run(
      session.agent,
      session.sessionId,
      session.filePath,
      session.codexHome,
      session.title,
      session.cwd,
      cwdKey(session.cwd),
      session.branch,
      session.createdAt,
      session.updatedAt ?? (session.agent === 'cursor' ? session.modifiedAt : null),
      session.messageCount,
      session.resumeCommand,
      contentHash.hash,
      contentHash.count,
      rowId
    )
  }

  upsertFile(
    candidate: SessionFileCandidate,
    byteOffset: number,
    sessionRowId: number | null,
    // Absent clears the hash, so a cursor never pairs with another offset's prefix.
    prefixHash?: string
  ): void {
    const { file } = candidate
    const identity = fileIdentity(file)
    this.upsertFileStmt ??= this.db.prepare(
      `INSERT INTO files(path, dev, ino, byte_offset, mtime_ms, size_bytes, session_row_id,
                           prefix_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           -- Partial observations must never create a pair that no stat proved.
           dev = CASE WHEN excluded.dev IS NOT NULL AND excluded.ino IS NOT NULL
             THEN excluded.dev ELSE files.dev END,
           ino = CASE WHEN excluded.dev IS NOT NULL AND excluded.ino IS NOT NULL
             THEN excluded.ino ELSE files.ino END,
           byte_offset = excluded.byte_offset, mtime_ms = excluded.mtime_ms,
           size_bytes = excluded.size_bytes, session_row_id = excluded.session_row_id,
           prefix_hash = excluded.prefix_hash`
    )
    this.upsertFileStmt.run(
      file.path,
      identity?.dev ?? null,
      identity?.ino ?? null,
      byteOffset,
      file.mtimeMs,
      file.sizeBytes ?? null,
      sessionRowId,
      prefixHash ?? null
    )
  }
}
