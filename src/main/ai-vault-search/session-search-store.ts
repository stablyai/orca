import type SyncDatabase from '../sqlite/sync-database'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import type { TranscriptSessionIdentity } from '../ai-vault/session-transcript-consumers'
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
import { openSessionSearchDatabase } from './session-search-schema'

// A paused store keeps recording what it declined, so the set needs a ceiling.
// Above it the oldest record goes and the drop is counted, because a re-read set
// that silently forgets is worse than one that says it is incomplete.
export const STALE_PATH_LIMIT = 20_000

/** One row of the index's own file table, joined to the agent that wrote it. */
export type SessionSearchIndexedSource = {
  path: string
  agent: AiVaultAgent | null
  codexHome: string | null
}

/**
 * Owns the index database. PR 2 scope: the write half only — the transcript
 * consumer writes through it and nothing reads from it yet. Lifecycle (who
 * indexes, when, and how the re-read set is drained) belongs to the service.
 */
export class SessionSearchStore {
  private readonly db: SyncDatabase
  private readonly writer: SessionSearchIndexWriter
  private closed = false
  private acceptingWrites = true
  private retentionCutoffMs: number | null = null
  // Files this index knows it is behind on. Filled by a declined or abandoned
  // read; PR 3's indexer drains it. Nothing here schedules the re-read.
  private readonly stale = new Map<string, SessionFileCandidate>()
  private droppedStalePaths = 0
  // One drain at a time. A replace that commits while one is running asks for
  // another pass rather than starting a second walk of the same rows.
  private draining = false
  private drainRequested = false

  constructor(
    path: string,
    private readonly onError: (error: unknown) => void = (error) =>
      console.warn(
        '[ai-vault-search] index write failed:',
        error instanceof Error ? error.name : 'IndexError'
      )
  ) {
    this.db = openSessionSearchDatabase(path)
    this.writer = new SessionSearchIndexWriter(this.db, SESSION_SEARCH_COMMIT_CHARS, () =>
      this.scheduleOrphanDrain()
    )
  }

  /**
   * Reclaims the rows a replace cut loose, once its transaction has committed.
   *
   * The same split retention makes, for the same reason: deleting the old
   * session row is what stops it answering, because every retrieval joins
   * `sessions`, and handing its messages back is the expensive half that must
   * not hold one transaction. Nothing records the work: rows whose session row
   * is gone are the whole record, so a crash before or during a drain is found
   * by the next one.
   */
  private scheduleOrphanDrain(): void {
    this.drainRequested = true
    if (this.draining || this.closed) {
      return
    }
    this.draining = true
    // Off the committing stack. An async function runs synchronously up to its
    // first `await`, so calling the drain here would put its first batch back
    // inside the call that committed the replace — the cost this took out.
    void Promise.resolve().then(() => this.runOrphanDrain())
  }

  private async runOrphanDrain(): Promise<void> {
    try {
      while (this.drainRequested && !this.closed) {
        this.drainRequested = false
        await drainOrphanedMessages(this.db, () => this.closed)
      }
    } catch (error) {
      if (!this.closed) {
        this.onError(error)
      }
    } finally {
      this.draining = false
    }
  }

  /**
   * The index handle, for a reader composed over this store (PR 4's engine).
   *
   * Two rules come with it, both measured in this PR. **Never hold a read
   * transaction across an `await`**: a checkpoint cannot pass an open read
   * snapshot, so a paginated read that opened `BEGIN` and yielded between pages
   * takes the WAL from 10 MB to 266 MB and it does not come back. And **no
   * `.iterate()` that outlives its statement**, which is the same pin by
   * another name. Every retrieval a single synchronous statement is the whole
   * contract.
   */
  get connection(): SyncDatabase {
    return this.db
  }

  setAcceptingWrites(accept: boolean): void {
    this.acceptingWrites = accept
  }

  /** The oldest transcript mtime worth indexing; PR 3 derives it from the retention setting. */
  setRetentionCutoffMs(cutoffMs: number | null): void {
    this.retentionCutoffMs = cutoffMs
  }

  /** Whether this candidate is new enough to be worth holding rows for at all. */
  private withinRetention(candidate: SessionFileCandidate): boolean {
    return this.retentionCutoffMs === null || candidate.file.mtimeMs >= this.retentionCutoffMs
  }

  /** Whether a write for this candidate may start right now. */
  acceptsCandidate(candidate: SessionFileCandidate): boolean {
    return !this.closed && this.acceptingWrites && this.withinRetention(candidate)
  }

  indexedFile(path: string, identity: SessionSearchFileIdentity): SessionSearchIndexedFile | null {
    try {
      return this.writer.indexedFile(path, identity)
    } catch (error) {
      this.onError(error)
      return null
    }
  }

  /** Null when this read cannot extend the index, or when the store refuses writes. */
  beginWrite(
    candidate: SessionFileCandidate,
    mode: 'replace' | 'append',
    previousByteOffset: number,
    identity?: () => TranscriptSessionIdentity | null
  ): SessionSearchFileWrite | null {
    if (!this.acceptsCandidate(candidate)) {
      return null
    }
    try {
      return this.writer.beginWrite(candidate, mode, previousByteOffset, identity)
    } catch (error) {
      this.reportWriteFailure(error)
      return null
    }
  }

  writeCommitted(candidate: SessionFileCandidate): void {
    // Why: a list scan queues every file the backfill has not reached yet; once
    // one lands, a later pass must not re-read the whole queue.
    this.stale.delete(candidate.file.path)
  }

  reportWriteFailure(error: unknown): void {
    this.onError(error)
  }

  /**
   * Records a file whose content the index is behind on, for a later whole
   * re-read. Recorded while paused too: a pause is exactly the window in which
   * reads are declined, so refusing to remember them would lose every file the
   * pause covered.
   */
  markStale(candidate: SessionFileCandidate): void {
    if (this.closed || !this.withinRetention(candidate)) {
      return
    }
    // Re-inserting moves the path to the end, so the oldest record is the one
    // dropped when a long pause overruns the bound.
    this.stale.delete(candidate.file.path)
    this.stale.set(candidate.file.path, candidate)
    while (this.stale.size > STALE_PATH_LIMIT) {
      const oldest = this.stale.keys().next()
      if (oldest.done) {
        break
      }
      this.stale.delete(oldest.value)
      this.droppedStalePaths += 1
    }
  }

  /**
   * Files the index knew it was behind on and could not keep a record of. A
   * non-zero count means the re-read set is incomplete, so coverage cannot be
   * reported as whole until a full pass runs.
   */
  get droppedPendingFileCount(): number {
    return this.droppedStalePaths
  }

  /**
   * Hands the re-read set to its scheduler and clears it.
   *
   * These paths are behind, not merely dirty: the index declined their last read
   * because it covered a span the index never saw. Re-dispatching a scan is not
   * enough on its own, because the reader picks `append` from the session list's
   * resume point and the consumer will decline again. The caller must pass each
   * path to `requestWholeTranscriptRead` first.
   */
  takeStale(): SessionFileCandidate[] {
    const candidates = [...this.stale.values()]
    this.stale.clear()
    return candidates
  }

  get pendingFileCount(): number {
    return this.stale.size
  }

  /** Whether this path is already recorded here, so a second queue can avoid counting it twice. */
  hasStale(path: string): boolean {
    return this.stale.has(path)
  }

  /** Files the index currently holds, for a status that reports what is there. */
  get indexedFileCount(): number {
    try {
      return Number((this.db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n)
    } catch (error) {
      this.onError(error)
      return 0
    }
  }

  /**
   * What this index believes it holds, for a scheduler that has to notice a
   * source that vanished while nothing was running. `paths` narrows it to a
   * lookup; omitting it walks the whole table, which only a full sweep does.
   */
  indexedSources(paths?: readonly string[]): SessionSearchIndexedSource[] {
    const sql = `SELECT f.path AS path, s.agent AS agent, s.codex_home AS codexHome
      FROM files f LEFT JOIN sessions s ON s.id = f.session_row_id`
    try {
      if (!paths) {
        return this.db.prepare(sql).all() as SessionSearchIndexedSource[]
      }
      const one = this.db.prepare(`${sql} WHERE f.path = ?`)
      return paths.flatMap((path) => one.all(path) as SessionSearchIndexedSource[])
    } catch (error) {
      this.onError(error)
      return []
    }
  }

  /**
   * Drops a source's rows. Only a proven deletion may call this: an unreadable
   * source is `unverifiable`, not `missing`, and keeps its rows
   * (docs/reference/ssh-execution-boundary.md).
   */
  removeFile(path: string): void {
    this.stale.delete(path)
    try {
      this.writer.removeFile(path)
    } catch (error) {
      this.onError(error)
    }
  }

  /** Cuts expired sessions loose at once, then reclaims their rows in resumable batches. */
  async purgeOlderThan(cutoffMs: number | null, signal?: AbortSignal): Promise<void> {
    try {
      await deleteExpiredSearchFiles(
        this.db,
        cutoffMs,
        () => this.closed || signal?.aborted === true
      )
    } catch (error) {
      if (!this.closed) {
        this.onError(error)
      }
    }
  }

  close(): void {
    // node:sqlite throws ERR_INVALID_STATE on a second close, and a store is
    // closed both by its owner and by a test's teardown.
    if (this.closed) {
      return
    }
    this.closed = true
    this.db.close()
  }
}
