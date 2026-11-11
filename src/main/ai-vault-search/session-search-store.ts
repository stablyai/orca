import { admitSessionSearchStoreWrite } from './session-search-store-write'
import {
  validSessionSearchRemoval,
  type SessionSearchRemovalReceipt
} from './session-search-observation-authority'
import {
  transitionSessionSearchCandidates,
  requireSessionSearchCandidateReason,
  transitionSessionSearchWork
} from './session-search-store-transitions'
import { SessionSearchWorkCatalog } from './session-search-work-catalog'
import type { SessionSearchWorkCommand, SessionSearchWorkResult } from './session-search-work-queue'
import {
  coversSessionSearchTranscript,
  sessionSearchResumableCursor
} from './session-search-committed-coverage'
import {
  SessionSearchCatalogCandidates,
  type SessionSearchCandidateCommand
} from './session-search-catalog-candidates'
import { SessionSearchCatalog, type SessionSearchCatalogCommand } from './session-search-catalog'
import {
  iterateSessionSearchFileRows,
  readSessionSearchFileRows,
  readSessionSearchStateCounts
} from './session-search-file-rows'
import { ensureSessionSearchQuerySchema } from './session-search-query-schema'
import type {
  SessionSearchFileRow,
  SessionSearchFileState,
  SessionSearchResumableCursor,
  SessionSearchStateCounts
} from './session-search-store-types'
export type {
  SessionSearchFileRow,
  SessionSearchFileState,
  SessionSearchResumableCursor,
  SessionSearchStateCounts,
  SessionSearchIndexStore
} from './session-search-store-types'
import type SyncDatabase from '../sqlite/sync-database'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type { TranscriptSessionIdentity } from '../ai-vault/transcripts/session-transcript-consumers'
import type {
  SessionSearchFileIdentity,
  SessionSearchIndexedFile
} from './session-search-file-cursor'
import {
  SESSION_SEARCH_COMMIT_CHARS,
  SessionSearchIndexWriter,
  type SessionSearchFileWrite
} from './session-search-index-writer'
import { deleteExpiredSearchFiles, drainOrphanedMessages } from './session-search-retention-delete'
import { reportSessionSearchBackgroundError } from './session-search-trace'
import { openSessionSearchDatabase } from './session-search-schema'

export class SessionSearchStore {
  private readonly db: SyncDatabase
  private readonly writer: SessionSearchIndexWriter
  private candidateCatalog: SessionSearchCatalogCandidates | undefined
  private scratch: SessionSearchCatalog | undefined
  private workCatalog: SessionSearchWorkCatalog | undefined
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

  get catalogPending(): boolean {
    return this.candidateCatalog?.hasPending ?? false
  }
  get catalogCandidates(): SessionSearchCatalogCandidates {
    this.candidateCatalog ??= new SessionSearchCatalogCandidates(this.db, (path) =>
      this.removeFile(path)
    )
    return this.candidateCatalog
  }
  candidates(command: SessionSearchCandidateCommand) {
    return transitionSessionSearchCandidates(this, command)
  }
  work(command: SessionSearchWorkCommand): Promise<SessionSearchWorkResult> {
    this.workCatalog ??= new SessionSearchWorkCatalog()
    return transitionSessionSearchWork(this, this.workCatalog, command)
  }
  private get scratchCatalog(): SessionSearchCatalog {
    this.scratch ??= new SessionSearchCatalog(this.db, (path, reason) =>
      requireSessionSearchCandidateReason(this, path, reason)
    )
    return this.scratch
  }
  async catalog(command: SessionSearchCatalogCommand) {
    return this.scratchCatalog.response(command)
  }

  validRemoval(path: string, receipt: SessionSearchRemovalReceipt): boolean {
    return !!this.scratch && validSessionSearchRemoval(this.scratch, path, receipt)
  }

  fileRow(path: string): SessionSearchFileRow | undefined {
    return readSessionSearchFileRows(this.db, path)[0]
  }

  *fileRows(): IterableIterator<SessionSearchFileRow> {
    yield* iterateSessionSearchFileRows(this.db)
  }

  indexedFile(path: string, identity: SessionSearchFileIdentity): SessionSearchIndexedFile | null {
    try {
      return this.writer.indexedFile(path, identity)
    } catch (error) {
      this.onError(error)
      return null
    }
  }

  coversTranscript(candidate: SessionFileCandidate): boolean {
    return coversSessionSearchTranscript(this.db, candidate, this.closed, this.onError)
  }
  resumableCursor(candidate: SessionFileCandidate): SessionSearchResumableCursor | null {
    return sessionSearchResumableCursor(this.db, candidate, this.closed, this.onError)
  }

  beginWrite(
    candidate: SessionFileCandidate,
    mode: 'replace' | 'append',
    previousByteOffset: number,
    identity?: () => TranscriptSessionIdentity | null,
    _indexing?: boolean,
    _signal?: AbortSignal,
    metadataOnly = false
  ): SessionSearchFileWrite | null {
    if (
      this.closed ||
      (this.retentionCutoffMs !== null && candidate.file.mtimeMs < this.retentionCutoffMs)
    ) {
      return null
    }
    try {
      return admitSessionSearchStoreWrite(
        this.db,
        this.writer,
        this.candidateCatalog,
        candidate,
        mode,
        previousByteOffset,
        identity,
        metadataOnly,
        () => this.fileRow(candidate.file.path)
      )
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

  files(): SessionSearchFileRow[] {
    return readSessionSearchFileRows(this.db)
  }

  setFileState(path: string, state: SessionSearchFileState, atMtimeMs?: number): void {
    try {
      this.candidateCatalog?.rowChanged(path)
      if (state === 'failed') {
        // Persist initial failures too, or unreadable new files retry forever.
        this.db
          .prepare(
            `INSERT INTO files(path, byte_offset, mtime_ms, state, fail_count, failed_mtime_ms)
             VALUES (?, 0, ?, 'failed', 1, ?)
             ON CONFLICT(path) DO UPDATE SET
               state = 'failed',
               fail_count = files.fail_count + 1,
               failed_mtime_ms = excluded.failed_mtime_ms`
          )
          .run(path, atMtimeMs ?? 0, atMtimeMs ?? null)
        return
      }
      this.db
        .prepare(
          'UPDATE files SET state = ?, fail_count = 0, failed_mtime_ms = NULL WHERE path = ?'
        )
        .run(state, path)
    } catch (error) {
      this.onError(error)
    }
  }

  stateCounts(): SessionSearchStateCounts {
    return readSessionSearchStateCounts(this.db)
  }

  /** Only proven deletion permits removal; unreadable sources retain their indexed rows. */
  removeFile(path: string): boolean {
    try {
      this.writer.removeFile(path)
      this.candidateCatalog?.rowChanged(path)
      return true
    } catch (error) {
      this.onError(error)
      return false
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
