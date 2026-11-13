import { SessionSearchTransactionEffects } from '../session-search-transaction-effects'
import { initializeSessionSearchStorage } from '../session-search-storage-bootstrap'
import { admitSessionSearchStoreWrite } from '../session-search-store-write'
import { applySessionSearchFileState } from '../session-search-file-state'
import {
  validSessionSearchRemoval,
  type SessionSearchRemovalReceipt
} from '../session-search-observation-authority'
import {
  transitionSessionSearchCandidates,
  requireSessionSearchCandidateReason,
  transitionSessionSearchWork
} from '../session-search-store-transitions'
import { SessionSearchWorkCatalog } from '../session-search-work-catalog'
import type {
  SessionSearchReadContext,
  SessionSearchWorkCommand,
  SessionSearchWorkResult
} from '../session-search-work-queue'
import {
  coversSessionSearchTranscript,
  sessionSearchResumableCursor
} from '../session-search-committed-coverage'
import {
  SessionSearchCatalogCandidates,
  type SessionSearchCandidateCommand
} from '../session-search-catalog-candidates'
import { SessionSearchCatalog, type SessionSearchCatalogCommand } from '../session-search-catalog'
import {
  iterateSessionSearchFileRows,
  readSessionSearchFileRows,
  readSessionSearchStateCounts
} from '../session-search-file-rows'
import { ensureSessionSearchQuerySchema } from './session-search-query-schema'
import type {
  SessionSearchFileRow,
  SessionSearchFileState,
  SessionSearchResumableCursor,
  SessionSearchStateCounts
} from './session-search-store-types'
import type SyncDatabase from '../../sqlite/sync-database'
import type { SessionFileCandidate } from '../../ai-vault/session-scanner-types'
import type { TranscriptSessionIdentity } from '../../ai-vault/transcripts/session-transcript-consumers'
import type {
  SessionSearchFileIdentity,
  SessionSearchIndexedFile
} from './session-search-file-cursor'
import {
  SESSION_SEARCH_COMMIT_CHARS,
  SessionSearchIndexWriter,
  type SessionSearchFileWrite
} from './session-search-index-writer'
import {
  deleteExpiredSearchFiles,
  SessionSearchOrphanCleanup
} from './session-search-retention-delete'
import { openSessionSearchDatabase } from './session-search-schema'

export class SessionSearchStore {
  private readonly db: SyncDatabase
  private readonly writer: SessionSearchIndexWriter
  private candidateCatalog: SessionSearchCatalogCandidates | undefined
  private scratch: SessionSearchCatalog | undefined
  private readonly effects: SessionSearchTransactionEffects
  private workCatalog: SessionSearchWorkCatalog | undefined
  private closed = false
  private retentionCutoffMs: number | null = null
  private readonly orphanCleanup: SessionSearchOrphanCleanup

  constructor(
    path: string,
    private readonly onError: (error: unknown) => void = (error) =>
      console.warn(
        '[ai-vault-search] index write failed:',
        error instanceof Error ? error.name : 'IndexError'
      ),
    private readonly onMessagesChanged: (delta: number) => void = () => undefined,
    publishSourceWake: (previous: SessionSearchFileRow, row: SessionSearchFileRow) => void = () =>
      undefined
  ) {
    this.effects = new SessionSearchTransactionEffects(
      () => {
        const candidates = this.catalogCandidates.rollbackPoint()
        const work = this.workCatalog?.rollbackPoint()
        return () => {
          candidates()
          work?.()
        }
      },
      (path) => this.fileRow(path),
      publishSourceWake
    )
    this.db = openSessionSearchDatabase(path)
    initializeSessionSearchStorage(this.db)
    ensureSessionSearchQuerySchema(this.db)
    this.orphanCleanup = new SessionSearchOrphanCleanup(
      this.db,
      () => this.closed,
      onMessagesChanged,
      this.onError
    )
    this.writer = new SessionSearchIndexWriter(
      this.db,
      SESSION_SEARCH_COMMIT_CHARS,
      (sessionRowId) => this.orphanCleanup.request(sessionRowId),
      onMessagesChanged
    )
    this.orphanCleanup.request()
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
    this.candidateCatalog ??= new SessionSearchCatalogCandidates(
      this.db,
      (path) => this.removeFile(path),
      (run) => this.catalogStorage.transaction('search_candidate_accept', run)
    )
    return this.candidateCatalog
  }
  candidates(command: SessionSearchCandidateCommand, _runtimeEpoch?: number) {
    return transitionSessionSearchCandidates(this, command)
  }
  work(
    command: SessionSearchWorkCommand,
    _runtimeEpoch?: number
  ): Promise<SessionSearchWorkResult> {
    return transitionSessionSearchWork(this, this.catalogWork, command)
  }
  get catalogWork(): SessionSearchWorkCatalog {
    this.workCatalog ??= new SessionSearchWorkCatalog(this.db, this.catalogStorage)
    return this.workCatalog
  }
  onSourceWake(previous: SessionSearchFileRow, row: SessionSearchFileRow): void {
    this.effects.wake(previous, row)
  }
  get catalogStorage(): SessionSearchCatalog {
    this.scratch ??= new SessionSearchCatalog(
      this.db,
      (path, reason) => requireSessionSearchCandidateReason(this, path, reason),
      this.effects
    )
    return this.scratch
  }
  async catalog(command: SessionSearchCatalogCommand, _runtimeEpoch?: number) {
    return this.catalogStorage.response(command)
  }

  removeReadWork(path: string): void {
    this.workCatalog?.removeAccepted(path)
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
    metadataOnly = false,
    read?: SessionSearchReadContext,
    onContentAccepted?: (revision: string) => void
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
        () => this.fileRow(candidate.file.path),
        () => this.closed,
        onContentAccepted,
        read ? { read, store: this } : undefined
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

  setFileState(
    path: string,
    state: SessionSearchFileState,
    atMtimeMs?: number,
    publish = true
  ): void {
    try {
      if (publish) {
        this.candidateCatalog?.rowChanged(path)
      }
      applySessionSearchFileState(
        this.db,
        path,
        state,
        atMtimeMs,
        state === 'failed' ? this.catalogStorage : this.scratch
      )
    } catch (error) {
      this.onError(error)
    }
  }
  settleAcceptedFile(path: string): void {
    applySessionSearchFileState(this.db, path, 'current', undefined, this.scratch)
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
      this.orphanCleanup.request()
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
    this.orphanCleanup.close()
    this.writer.close()
    this.db.close()
  }
}
