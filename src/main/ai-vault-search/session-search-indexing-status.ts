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
export type SessionSearchIndexPhase = 'idle' | 'indexing' | 'current' | 'degraded' | 'closed'

export type SessionSearchIndexStatus = {
  phase: SessionSearchIndexPhase
  /** Files the index holds right now, counted in the store. */
  filesIndexed: number
  /**
   * Transcript bytes the pass that just ran read. Per pass, not since start: a
   * counter that only reset on sweeps sawtoothed every `fullSweepEveryCycles`,
   * which reads as activity nobody caused.
   */
  bytesIndexed: number
  /** Files the index knows it is behind on and has not read yet. */
  filesPending: number
  /**
   * Queue entries dropped at the bound. Non-zero means the queue is knowingly
   * incomplete, so coverage cannot be reported as whole until the next sweep.
   */
  droppedPending: number
  /**
   * Files the index has given up re-reading until their stat changes. A gauge,
   * not a tally: it falls when one becomes readable again, and a non-zero value
   * is a coverage gap the user can act on rather than an event that has passed.
   */
  unreadableFiles: number
  degradedRoots: SessionSearchDegradedRoot[]
  lastReconcileAt: number | null
}

/** Observes the backfill and the reconciler; owns no work and no timers. */
export class SessionSearchIndexingStatus {
  private working = false
  private started = false
  private closed = false
  private sweptClean = false
  private filesIndexed = 0
  private bytesIndexed = 0
  private filesPending = 0
  private droppedPending = 0
  private unreadableFiles = 0
  private degradedRoots: SessionSearchDegradedRoot[] = []
  private lastReconcileAt: number | null = null

  snapshot(): SessionSearchIndexStatus {
    return {
      phase: this.phase(),
      filesIndexed: this.filesIndexed,
      bytesIndexed: this.bytesIndexed,
      filesPending: this.filesPending,
      droppedPending: this.droppedPending,
      unreadableFiles: this.unreadableFiles,
      degradedRoots: this.degradedRoots.map((root) => ({ ...root })),
      lastReconcileAt: this.lastReconcileAt
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
      // Before `start()` nothing runs and nothing is owed; `reconcile()` throws
      // here too, so there is no work in flight to describe.
      return 'idle'
    }
    // Why work outranks degradation: a run in progress is the more useful thing
    // to show, and the degraded roots are still in the snapshot either way.
    if (this.working) {
      return 'indexing'
    }
    // A file the index cannot read is a gap waiting will not close, so it is
    // degradation rather than work in progress.
    if (this.degradedRoots.length > 0 || this.unreadableFiles > 0) {
      return 'degraded'
    }
    return this.sweptClean && this.filesPending === 0 ? 'current' : 'indexing'
  }

  setClosed(): void {
    this.closed = true
    this.working = false
  }

  /**
   * One whole sweep finished, or did not. The outcome is the argument rather
   * than the call site's position, so an aborted sweep cannot latch this by
   * being reported a line too early.
   */
  sweepFinished(completed: boolean): void {
    this.sweptClean ||= completed
  }

  /** Files the index holds, counted in the store rather than tallied per attempt. */
  setFilesIndexed(files: number): void {
    this.filesIndexed = files
  }

  /** `start()` was called; from here the phases describe work. */
  setStarted(): void {
    this.started = true
  }

  beginSweep(): void {
    this.beginCycle()
  }

  beginCycle(): void {
    this.working = true
    this.bytesIndexed = 0
  }

  indexed(bytes: number): void {
    this.bytesIndexed += bytes
  }

  setUnreadableFiles(files: number): void {
    this.unreadableFiles = files
  }

  setPending(pending: number, dropped: number): void {
    this.filesPending = pending
    this.droppedPending = dropped
  }

  setDegradedRoots(roots: SessionSearchDegradedRoot[]): void {
    this.degradedRoots = roots
  }

  finishWork(atMs: number): void {
    this.working = false
    this.lastReconcileAt = atMs
  }
}
