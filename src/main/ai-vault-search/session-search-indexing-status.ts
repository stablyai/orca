import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type { SessionSearchDiscoveredCount } from './session-search-discovered-counts'
import type { SessionSearchDegradedRoot } from './session-search-degraded-roots'

/**
 * `current` is the honest ceiling: the reconciler promises the newest N per
 * agent within one interval, not every transcript on the machine, so nothing
 * here ever claims the whole index is up to date.
 *
 * `idle` is the other end of it: an indexer nobody has started is not behind on
 * anything, because it never promised to index. Reporting that as `indexing`
 * described work that no timer was going to do.
 */
export type SessionSearchIndexPhase =
  | 'idle'
  | 'discovering'
  | 'indexing'
  | 'current'
  | 'paused'
  | 'degraded'
  | 'closed'

export type SessionSearchIndexStatus = {
  phase: SessionSearchIndexPhase
  /** Files the index holds right now, and what the running sweep set out to read. */
  filesIndexed: number
  filesTotal: number | null
  bytesIndexed: number
  /** Queued re-reads: the store's stale set plus whatever the budget rolled over. */
  filesPending: number
  /**
   * Re-reads dropped at a bound, the indexer's queue and the store's re-read set
   * together. Non-zero means the queue is knowingly incomplete, so coverage
   * cannot be reported as whole until the next full sweep.
   */
  droppedPending: number
  /** Unfinished writes the open tombstoned; a non-zero value means a crash. */
  recoveredRows: number
  failures: number
  /**
   * Files the index holds under no root it is configured to walk, still on
   * disk. Their rows are kept and never refreshed, so a non-zero count is a
   * configuration problem to surface rather than rows to delete.
   */
  orphanedFiles: number
  degradedRoots: SessionSearchDegradedRoot[]
  lastReconcileAt: number | null
  discovered: Record<string, SessionSearchDiscoveredCount>
}

/** Observes the backfill and the reconciler; owns no work and no timers. */
export class SessionSearchIndexingStatus {
  private working: 'discovering' | 'indexing' | null = null
  private started = false
  private paused = false
  private closed = false
  private sweptClean = false
  private filesIndexed = 0
  private filesTotal: number | null = null
  private bytesIndexed = 0
  private filesPending = 0
  private droppedPending = 0
  private recoveredRows = 0
  private failures = 0
  private orphanedFiles = 0
  private degradedRoots: SessionSearchDegradedRoot[] = []
  private lastReconcileAt: number | null = null
  private discovered = new Map<AiVaultAgent, SessionSearchDiscoveredCount>()

  snapshot(): SessionSearchIndexStatus {
    return {
      phase: this.phase(),
      filesIndexed: this.filesIndexed,
      // Never below what the index already holds: the sweep's plan counts the
      // transcripts on disk, and the store also holds rows a plan does not
      // cover — orphans, and files retired later in the same pass — so the
      // unclamped pair reports progress above 100 percent.
      filesTotal: this.filesTotal === null ? null : Math.max(this.filesTotal, this.filesIndexed),
      bytesIndexed: this.bytesIndexed,
      filesPending: this.filesPending,
      droppedPending: this.droppedPending,
      recoveredRows: this.recoveredRows,
      failures: this.failures,
      orphanedFiles: this.orphanedFiles,
      degradedRoots: this.degradedRoots.map((root) => ({ ...root })),
      lastReconcileAt: this.lastReconcileAt,
      discovered: Object.fromEntries(this.discovered)
    }
  }

  /**
   * `current` is a claim, so it takes all three: nothing queued, no root the
   * index could not read, and a whole sweep that actually finished. Anything
   * short of that is still work in progress, however quiet it looks.
   */
  private phase(): SessionSearchIndexPhase {
    if (this.closed) {
      return 'closed'
    }
    if (!this.started) {
      // Before `start()` nothing runs and nothing is owed; `reconcile()` is
      // refused here too, so there is no work in flight to describe.
      return 'idle'
    }
    if (this.paused) {
      return 'paused'
    }
    // Why work outranks degradation: a run in progress is the more useful thing
    // to show, and the degraded roots are still in the snapshot either way.
    if (this.working) {
      return this.working
    }
    if (this.degradedRoots.length > 0) {
      return 'degraded'
    }
    return this.sweptClean && this.filesPending === 0 ? 'current' : 'indexing'
  }

  setClosed(): void {
    this.closed = true
    this.working = null
  }

  /**
   * One whole sweep finished, or did not. The outcome is the argument rather
   * than the call site's position, so an aborted sweep cannot latch this by
   * being reported a line too early.
   */
  sweepFinished(completed: boolean): void {
    this.sweptClean ||= completed
  }

  /** After `clear()`: the index is empty again, so no sweep has covered it. */
  forgetSweep(): void {
    this.sweptClean = false
  }

  /** Files the index holds, counted in the store rather than tallied per attempt. */
  setFilesIndexed(files: number): void {
    this.filesIndexed = files
  }

  /** `start()` was called; from here the phases describe work. */
  setStarted(): void {
    this.started = true
  }

  setPaused(paused: boolean): void {
    this.paused = paused
  }

  setRecoveredRows(rows: number): void {
    this.recoveredRows = rows
  }

  /** A full sweep restarts the progress pair; a reconcile cycle only reports work. */
  beginSweep(): void {
    this.working = 'discovering'
    this.filesTotal = null
    this.bytesIndexed = 0
    this.failures = 0
  }

  beginCycle(): void {
    this.working ??= 'indexing'
    // A cycle reads the recency window, not a population; carrying the last
    // sweep's total through it would report a ratio against the wrong thing.
    this.filesTotal = null
  }

  setDiscovered(counts: Map<AiVaultAgent, SessionSearchDiscoveredCount>): void {
    this.discovered = counts
  }

  /** Total is what the sweep will actually read, after retention filtering. */
  planned(total: number, failures: number): void {
    this.working = 'indexing'
    this.filesTotal = total
    this.failures += failures
  }

  indexed(bytes: number): void {
    this.bytesIndexed += bytes
  }

  failed(): void {
    this.failures += 1
  }

  setPending(pending: number, dropped: number): void {
    this.filesPending = pending
    this.droppedPending = dropped
  }

  setOrphanedFiles(files: number): void {
    this.orphanedFiles = files
  }

  setDegradedRoots(roots: SessionSearchDegradedRoot[]): void {
    this.degradedRoots = roots
  }

  finishWork(atMs: number): void {
    this.working = null
    this.lastReconcileAt = atMs
  }
}
