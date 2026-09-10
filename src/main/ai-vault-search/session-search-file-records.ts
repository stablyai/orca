import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { TranscriptSessionIdentity } from '../ai-vault/session-transcript-consumers'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type SyncDatabase from '../sqlite/sync-database'
import { EMPTY_CONTENT_HASH, type SessionContentHash } from './session-search-content-hash'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

/**
 * The stored comparison key for a session's working directory.
 *
 * Why the shared normalizer verbatim: the sidebar already groups sessions by
 * `folderGroupKey`, which is this function under a prefix. A second spelling
 * here means any later join between an indexed hit and a sidebar group returns
 * nothing. An earlier version qualified a WSL cwd with its distro so two
 * distros could not collide at `/home/me/repo`; that is a real collision, but it
 * is one every SSH host has too, neither key qualifies for SSH, and the fix for
 * it is a column that names the execution host, not a path key that only some
 * hosts spell differently.
 */
export function cwdKey(cwd: string | null): string | null {
  return cwd ? normalizeRuntimePathForComparison(cwd) : null
}

export class SessionSearchFileRecords {
  constructor(private readonly db: SyncDatabase) {}
  /**
   * The row a read hangs its messages off, before the parser has said what the
   * session is. The same transaction fills it in: from the decoded session when
   * the read finished, and from `updateProvisionalSession` when this is a chunk
   * of one that has not.
   */
  createSessionRow(candidate: SessionFileCandidate): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO sessions(agent,session_id,file_path,title,resume_command)
      VALUES (?,'',?,'','')`
        )
        .run(candidate.agent, candidate.file.path).lastInsertRowid
    )
  }

  /**
   * Writes what the parser knows so far onto a session a chunk is committing.
   *
   * Rows a chunk commits answer searches the moment they land, so the session
   * they hang off has to be nameable before the read producing it ends — and it
   * may never end, because a crash between chunks leaves exactly this row. That
   * is why the identity is required rather than optional: a read that has none
   * does not chunk at all. The final commit overwrites all of it from the
   * decoded session; until then the title in particular is provisional.
   */
  updateProvisionalSession(rowId: number, identity: TranscriptSessionIdentity): void {
    this.db
      .prepare(
        `UPDATE sessions SET session_id = ?, title = ?, cwd = ?, cwd_key = ?,
         created_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        identity.sessionId,
        identity.title ?? '',
        identity.cwd,
        cwdKey(identity.cwd),
        identity.createdAt,
        identity.updatedAt,
        rowId
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
      session.title,
      session.cwd,
      cwdKey(session.cwd),
      session.branch,
      session.createdAt,
      session.updatedAt,
      session.messageCount,
      session.resumeCommand,
      contentHash.hash,
      contentHash.count
    ]
    this.db
      .prepare(
        `UPDATE sessions SET agent = ?, session_id = ?, file_path = ?, codex_home = ?, title = ?,
        cwd = ?, cwd_key = ?, branch = ?, created_at = ?, updated_at = ?, message_count = ?, resume_command = ?,
        content_hash = ?, content_hash_count = ? WHERE id = ?`
      )
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
         ON CONFLICT(path) DO UPDATE SET
           -- Why COALESCE: a host that cannot stat dev/ino (SSH, WSL, a degraded
           -- Windows stat) must not erase an identity an earlier scan proved, or
           -- the next rename-replace of this path becomes undetectable.
           dev = COALESCE(excluded.dev, files.dev), ino = COALESCE(excluded.ino, files.ino),
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
