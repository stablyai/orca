import type SyncDatabase from '../sqlite/sync-database'
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

/**
 * What a row still owes a reader.
 *
 * `current`: the rows match the file at the stat this row records.
 * `due`: the index is behind on a span it cannot reach by appending, so the
 * next pass must read the file whole.
 * `failed`: the last read did not commit; `failCount` and `failedMtimeMs` are
 * what stop it being retried for ever.
 */
export type SessionSearchFileState = 'current' | 'due' | 'failed'

/**
 * One row of the index's own file table.
 *
 * This is the indexer's whole memory between passes: what it holds, at what
 * stat, and what each row still owes. Nothing it decides is answered from
 * anywhere else, which is why a second connection can check its status.
 */
export type SessionSearchFileRow = {
  path: string
  identity: SessionSearchFileIdentity
  mtimeMs: number
  sizeBytes: number | null
  state: SessionSearchFileState
  failCount: number
  failedMtimeMs: number | null
}

/** How many rows are in each state; the whole of the indexer's progress report. */
export type SessionSearchStateCounts = { current: number; due: number; failed: number }

/**
 * Owns the index database. PR 2 scope: the write half only — the transcript
 * consumer writes through it and nothing reads from it yet. Lifecycle (who
 * indexes, when, and how the re-read set is drained) belongs to the service.
 */
export class SessionSearchStore {
  private readonly db: SyncDatabase
  private readonly writer: SessionSearchIndexWriter
  private closed = false
  private retentionCutoffMs: number | null = null
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

  /** The oldest transcript mtime worth indexing; PR 3 derives it from the retention setting. */
  setRetentionCutoffMs(cutoffMs: number | null): void {
    this.retentionCutoffMs = cutoffMs
  }

  /** The cutoff a caller's own decide step compares a candidate's mtime against. */
  get retentionCutoff(): number | null {
    return this.retentionCutoffMs
  }

  /**
   * Whether this candidate is new enough to hold rows for.
   *
   * Enforced here as well as in the indexer's decide step, and not only there:
   * the consumer observes every read the session list makes, not only the ones
   * the index asked for, so a sidebar scan of a transcript outside the window
   * would otherwise index rows the next purge deletes again.
   */
  private withinRetention(candidate: SessionFileCandidate): boolean {
    return this.retentionCutoffMs === null || candidate.file.mtimeMs >= this.retentionCutoffMs
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
    if (this.closed || !this.withinRetention(candidate)) {
      return null
    }
    try {
      return this.writer.beginWrite(candidate, mode, previousByteOffset, identity)
    } catch (error) {
      this.reportWriteFailure(error)
      return null
    }
  }

  /**
   * A read that landed. Written after the commit rather than inside it: the
   * transaction owns the rows and the cursor, and a crash between the two
   * leaves a row that says `failed` over content that is in fact current, which
   * the next pass fixes by reading a file it did not have to.
   */
  writeCommitted(candidate: SessionFileCandidate): void {
    this.setFileState(candidate.file.path, 'current')
  }

  reportWriteFailure(error: unknown): void {
    this.onError(error)
  }

  /**
   * Every row this index holds. The candidate list for retirement and the whole
   * of the status, read in one query so that no pass has to carry either.
   *
   * The cursor is deliberately not here: whether a row can be continued is
   * `indexedFile`'s question, and one spelling of the half-written sentinel is
   * enough.
   */
  files(): SessionSearchFileRow[] {
    return (
      this.db
        .prepare(
          `SELECT path, dev, ino, mtime_ms AS mtimeMs, size_bytes AS sizeBytes,
                  state, fail_count AS failCount, failed_mtime_ms AS failedMtimeMs
           FROM files`
        )
        .all() as (Omit<SessionSearchFileRow, 'identity'> & {
        dev: number | null
        ino: number | null
      })[]
    ).map((row) => ({
      path: row.path,
      identity:
        typeof row.dev === 'number' && typeof row.ino === 'number'
          ? { dev: row.dev, ino: row.ino }
          : null,
      mtimeMs: row.mtimeMs,
      sizeBytes: row.sizeBytes,
      state: row.state,
      failCount: row.failCount,
      failedMtimeMs: row.failedMtimeMs
    }))
  }

  /**
   * Moves a row's read state.
   *
   * `failed` also counts the failure and records the stat it happened at, which
   * is what lets the next pass tell "this file has never worked" from "this
   * file has changed since it last failed". A path with no row is a no-op: the
   * next pass reads it because the index holds nothing for it.
   */
  setFileState(path: string, state: SessionSearchFileState, atMtimeMs?: number): void {
    try {
      if (state === 'failed') {
        // Inserted when there is no row, because the common unreadable file is
        // one the index never managed to hold: a transcript behind the wrong
        // mode bits fails on its very first read, and with nowhere to write the
        // count it would be read again on every pass for the life of the
        // process. The cursor is zero and there is no session, which is what
        // "the index holds nothing for this file" already looks like.
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

  /** Rows per state. The status is this query and the pass's own degraded roots. */
  stateCounts(): SessionSearchStateCounts {
    const rows = this.db.prepare('SELECT state, count(*) AS n FROM files GROUP BY state').all() as {
      state: SessionSearchFileState
      n: number
    }[]
    const counts: SessionSearchStateCounts = { current: 0, due: 0, failed: 0 }
    for (const row of rows) {
      counts[row.state] = Number(row.n)
    }
    return counts
  }

  /**
   * Drops a source's rows. Only a proven deletion may call this: an unreadable
   * source is `unverifiable`, not `missing`, and keeps its rows
   * (docs/reference/ssh-execution-boundary.md).
   */
  removeFile(path: string): void {
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
