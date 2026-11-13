import { ensureSessionSearchQuerySchema } from './session-search-query-schema'
import type {
  SessionSearchFileRow,
  SessionSearchFileState,
  SessionSearchResumableCursor,
  SessionSearchStateCounts
} from './session-search-store-types'
import type SyncDatabase from '../../sqlite/sync-database'
import { asRecord } from '../../ai-vault/parsing/session-record-fields'
import type { SessionFileCandidate } from '../../ai-vault/session-scanner-types'
import type { TranscriptSessionIdentity } from '../../ai-vault/transcripts/session-transcript-consumers'
import {
  fileIdentity,
  type SessionSearchFailureStat,
  type SessionSearchFileIdentity,
  type SessionSearchIndexedFile
} from './session-search-file-cursor'
import { readSessionSearchFileRows } from './session-search-file-rows'
import {
  SESSION_SEARCH_COMMIT_CHARS,
  SessionSearchIndexWriter,
  type SessionSearchFileWrite
} from './session-search-index-writer'
import { deleteExpiredSearchFiles, drainOrphanedMessages } from './session-search-retention-delete'
import { reportSessionSearchBackgroundError } from '../session-search-trace'
import { openSessionSearchDatabase } from './session-search-schema'

export class SessionSearchStore {
  private readonly db: SyncDatabase
  private readonly writer: SessionSearchIndexWriter
  private closed = false
  private retentionCutoffMs: number | null = null
  // Coalesce replacements into one drain, rerunning if more rows become orphaned.
  private draining = false
  private drainRequested = false

  constructor(
    path: string,
    private readonly onError: (error: unknown) => void = (error) =>
      console.warn(
        '[ai-vault-search] index write failed:',
        error instanceof Error ? error.name : 'IndexError'
      ),
    private readonly onMessagesChanged: (delta: number) => void = () => undefined
  ) {
    this.db = openSessionSearchDatabase(path)
    ensureSessionSearchQuerySchema(this.db)
    this.writer = new SessionSearchIndexWriter(
      this.db,
      SESSION_SEARCH_COMMIT_CHARS,
      () => this.scheduleOrphanDrain(),
      onMessagesChanged
    )
  }

  /** Reclaim orphaned rows in batches; their missing session rows also make crash recovery resumable. */
  private scheduleOrphanDrain(): void {
    this.drainRequested = true
    if (this.draining || this.closed) {
      return
    }
    this.draining = true
    // Defer the first synchronous drain batch until after the committing call returns.
    void Promise.resolve().then(() => this.runOrphanDrain())
  }

  private async runOrphanDrain(): Promise<void> {
    try {
      while (this.drainRequested && !this.closed) {
        this.drainRequested = false
        await drainOrphanedMessages(this.db, () => this.closed, undefined, this.onMessagesChanged)
      }
    } catch (error) {
      if (!this.closed) {
        reportSessionSearchBackgroundError(this.onError, error)
      }
    } finally {
      this.draining = false
    }
  }

  /** Keep reads synchronous: transactions or iterators held across awaits pin the WAL. */
  get connection(): SyncDatabase {
    return this.db
  }

  setRetentionCutoffMs(cutoffMs: number | null): void {
    this.retentionCutoffMs = cutoffMs
  }

  get retentionCutoff(): number | null {
    return this.retentionCutoffMs
  }

  indexedFile(path: string, identity: SessionSearchFileIdentity): SessionSearchIndexedFile | null {
    try {
      return this.writer.indexedFile(path, identity)
    } catch (error) {
      this.onError(error)
      return null
    }
  }

  /** A cold list read must not rewrite a complete, unchanged search entry. */
  coversTranscript(candidate: SessionFileCandidate): boolean {
    const file = candidate.file
    if (this.closed || typeof file.sizeBytes !== 'number') {
      return false
    }
    const identity = fileIdentity(file)
    try {
      return (
        this.db
          .prepare(
            // With a known file identity, a missing stored identity must force a rewrite.
            `SELECT 1 FROM files WHERE path = ? AND state = 'current'
           AND mtime_ms = ? AND size_bytes = ? AND byte_offset = size_bytes
           AND (? IS NULL OR (CAST(dev AS REAL) = ? AND CAST(ino AS REAL) = ?))`
          )
          .get(
            file.path,
            file.mtimeMs,
            file.sizeBytes,
            identity?.dev ?? null,
            identity?.dev ?? null,
            identity?.ino ?? null
          ) !== undefined
      )
    } catch (error) {
      this.onError(error)
      return false
    }
  }

  /** A current cursor with bytes past it, and the hash a replacement read must reproduce to append there. */
  resumableCursor(candidate: SessionFileCandidate): SessionSearchResumableCursor | null {
    const file = candidate.file
    if (this.closed || typeof file.sizeBytes !== 'number') {
      return null
    }
    const identity = fileIdentity(file)
    try {
      const row = asRecord(
        this.db
          .prepare(
            `SELECT byte_offset AS byteOffset, prefix_hash AS prefixHash FROM files
             WHERE path = ? AND state = 'current' AND prefix_hash IS NOT NULL
             AND byte_offset > 0 AND byte_offset < ?
             AND (? IS NULL OR (CAST(dev AS REAL) = ? AND CAST(ino AS REAL) = ?))`
          )
          .get(
            file.path,
            file.sizeBytes,
            identity?.dev ?? null,
            identity?.dev ?? null,
            identity?.ino ?? null
          )
      )
      return typeof row?.byteOffset === 'number' && typeof row.prefixHash === 'string'
        ? { byteOffset: row.byteOffset, prefixHash: row.prefixHash }
        : null
    } catch (error) {
      this.onError(error)
      return null
    }
  }

  beginWrite(
    candidate: SessionFileCandidate,
    mode: 'replace' | 'append',
    previousByteOffset: number,
    identity?: () => TranscriptSessionIdentity | null,
    _indexing?: boolean,
    _signal?: AbortSignal
  ): SessionSearchFileWrite | null {
    if (
      this.closed ||
      (this.retentionCutoffMs !== null && candidate.file.mtimeMs < this.retentionCutoffMs)
    ) {
      return null
    }
    try {
      return this.writer.beginWrite(candidate, mode, previousByteOffset, identity)
    } catch (error) {
      this.reportWriteFailure(error)
      return null
    }
  }

  /** Mark current after commit; a crash in between causes a harmless reread. */
  writeCommitted(candidate: SessionFileCandidate): void {
    this.setFileState(candidate.file.path, 'current')
  }

  reportWriteFailure(error: unknown): void {
    this.onError(error)
  }

  /** Snapshot every indexed file with its stat, for diffing against a fresh discovery pass. */
  files(): SessionSearchFileRow[] {
    return readSessionSearchFileRows(
      this.db
        .prepare(
          // Numeric stat IDs may exceed SQLite's safe INTEGER-to-number read range.
          `SELECT path, CAST(dev AS REAL) AS dev, CAST(ino AS REAL) AS ino,
                  mtime_ms AS mtimeMs, size_bytes AS sizeBytes,
                  sidecar_mtime_ms AS sidecarMtimeMs, sidecar_size_bytes AS sidecarSizeBytes,
                  state, fail_count AS failCount, failed_mtime_ms AS failedMtimeMs,
                  failed_sidecar_mtime_ms AS failedSidecarMtimeMs,
                  failed_sidecar_size_bytes AS failedSidecarSizeBytes,
                  failed_at_ms AS failedAtMs
           FROM files`
        )
        .all()
    )
  }

  setFileState(
    path: string,
    state: SessionSearchFileState,
    failure?: SessionSearchFailureStat
  ): void {
    try {
      if (state === 'failed') {
        // Persist initial failures too, or unreadable new files retry forever. The sidecar stamp
        // belongs here because an unchanged metadata file cannot release a held-out sidecar append,
        // and the clock because a source whose stat never moves can still become readable.
        this.db
          .prepare(
            `INSERT INTO files(path, byte_offset, mtime_ms, state, fail_count, failed_mtime_ms,
                               failed_sidecar_mtime_ms, failed_sidecar_size_bytes, failed_at_ms)
             VALUES (?, 0, ?, 'failed', 1, ?, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET
               state = 'failed',
               fail_count = files.fail_count + 1,
               failed_mtime_ms = excluded.failed_mtime_ms,
               failed_sidecar_mtime_ms = excluded.failed_sidecar_mtime_ms,
               failed_sidecar_size_bytes = excluded.failed_sidecar_size_bytes,
               failed_at_ms = excluded.failed_at_ms`
          )
          .run(
            path,
            failure?.mtimeMs ?? 0,
            failure?.mtimeMs ?? null,
            failure?.sidecarMtimeMs ?? null,
            failure?.sidecarSizeBytes ?? null,
            Date.now()
          )
        return
      }
      this.db
        .prepare(
          `UPDATE files SET state = ?, fail_count = 0, failed_mtime_ms = NULL,
           failed_sidecar_mtime_ms = NULL, failed_sidecar_size_bytes = NULL,
           failed_at_ms = NULL WHERE path = ?`
        )
        .run(state, path)
    } catch (error) {
      this.onError(error)
    }
  }

  stateCounts(): SessionSearchStateCounts {
    const rows = this.db.prepare('SELECT state, count(*) AS n FROM files GROUP BY state').all() as {
      state: SessionSearchFileState
      n: number
    }[]
    const counts: SessionSearchStateCounts = {
      current: 0,
      due: 0,
      failed: 0,
      sessionsByAgent: this.sessionsByAgent(),
      messages: 0
    }
    for (const row of rows) {
      counts[row.state] = Number(row.n)
    }
    counts.messages = Number(
      asRecord(this.db.prepare('SELECT count(*) AS n FROM messages').get())?.n ?? 0
    )
    return counts
  }

  // Count indexed sessions without scanning their messages on every status poll.
  private sessionsByAgent(): Record<string, number> {
    const rows = this.db.prepare('SELECT agent, count(*) AS n FROM sessions GROUP BY agent').all()
    const counts: Record<string, number> = {}
    for (const row of rows) {
      const agent = asRecord(row)?.agent
      const total = asRecord(row)?.n
      if (typeof agent === 'string' && typeof total === 'number') {
        counts[agent] = total
      }
    }
    return counts
  }

  /** Only proven deletion permits removal; unreadable sources retain their indexed rows. */
  removeFile(path: string): void {
    try {
      this.writer.removeFile(path)
    } catch (error) {
      this.onError(error)
    }
  }

  async purgeOlderThan(cutoffMs: number | null, signal?: AbortSignal): Promise<void> {
    try {
      await deleteExpiredSearchFiles(
        this.db,
        cutoffMs,
        () => this.closed || signal?.aborted === true,
        undefined,
        this.onMessagesChanged,
        false
      )
      this.scheduleOrphanDrain()
    } catch (error) {
      if (!this.closed) {
        this.onError(error)
      }
    }
  }

  close(): void {
    // Repeated close calls throw ERR_INVALID_STATE in node:sqlite.
    if (this.closed) {
      return
    }
    this.closed = true
    this.writer.close()
    this.db.close()
  }
}
