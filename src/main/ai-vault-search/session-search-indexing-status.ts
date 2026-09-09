import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type { SessionSearchDiscoveredCount } from './session-search-discovered-counts'
import type { SessionSearchDegradedRoot } from './session-search-root-health'

/**
 * `current` is the honest ceiling: the reconciler promises the newest N per
 * agent within one interval, not every transcript on the machine, so nothing
 * here ever claims the whole index is up to date.
 */
export type SessionSearchIndexPhase = 'discovering' | 'indexing' | 'current' | 'paused' | 'degraded'

export type SessionSearchIndexStatus = {
  phase: SessionSearchIndexPhase
  /** Files read into the index since the current backfill began, and its total. */
  filesIndexed: number
  filesTotal: number | null
  bytesIndexed: number
  /** Queued re-reads: the store's stale set plus whatever the budget rolled over. */
  filesPending: number
  /** Pending entries dropped at the bound, so a long pause cannot grow memory. */
  droppedPending: number
  /** Unfinished writes the open tombstoned; a non-zero value means a crash. */
  recoveredRows: number
  failures: number
  degradedRoots: SessionSearchDegradedRoot[]
  lastReconcileAt: number | null
  discovered: Record<string, SessionSearchDiscoveredCount>
}

/** Observes the backfill and the reconciler; owns no work and no timers. */
export class SessionSearchIndexingStatus {
  private working: 'discovering' | 'indexing' | null = null
  private paused = false
  private filesIndexed = 0
  private filesTotal: number | null = null
  private bytesIndexed = 0
  private filesPending = 0
  private droppedPending = 0
  private recoveredRows = 0
  private failures = 0
  private degradedRoots: SessionSearchDegradedRoot[] = []
  private lastReconcileAt: number | null = null
  private discovered = new Map<AiVaultAgent, SessionSearchDiscoveredCount>()

  snapshot(): SessionSearchIndexStatus {
    return {
      phase: this.phase(),
      filesIndexed: this.filesIndexed,
      filesTotal: this.filesTotal,
      bytesIndexed: this.bytesIndexed,
      filesPending: this.filesPending,
      droppedPending: this.droppedPending,
      recoveredRows: this.recoveredRows,
      failures: this.failures,
      degradedRoots: this.degradedRoots.map((root) => ({ ...root })),
      lastReconcileAt: this.lastReconcileAt,
      discovered: Object.fromEntries(this.discovered)
    }
  }

  private phase(): SessionSearchIndexPhase {
    if (this.paused) {
      return 'paused'
    }
    // Why work outranks degradation: a run in progress is the more useful thing
    // to show, and the degraded roots are still in the snapshot either way.
    if (this.working) {
      return this.working
    }
    return this.degradedRoots.length > 0 ? 'degraded' : 'current'
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
    this.filesIndexed = 0
    this.filesTotal = null
    this.bytesIndexed = 0
    this.failures = 0
  }

  beginCycle(): void {
    this.working ??= 'indexing'
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
    this.filesIndexed += 1
    this.bytesIndexed += bytes
  }

  failed(): void {
    this.failures += 1
  }

  setPending(pending: number, dropped: number): void {
    this.filesPending = pending
    this.droppedPending = dropped
  }

  setDegradedRoots(roots: SessionSearchDegradedRoot[]): void {
    this.degradedRoots = roots
  }

  finishWork(atMs: number): void {
    this.working = null
    this.lastReconcileAt = atMs
  }
}
