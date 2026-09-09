import { runSessionSearchBackfill } from './session-search-backfill'
import { pauseBackfill } from './session-search-backfill-pacing'
import { systemSessionSearchClock, type SessionSearchClock } from './session-search-clock'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import {
  SessionSearchIndexingStatus,
  type SessionSearchIndexStatus
} from './session-search-indexing-status'
import { SessionSearchPendingFiles } from './session-search-pending-files'
import {
  DEFAULT_SESSION_SEARCH_BUDGET,
  SessionSearchCycleAllowance,
  type SessionSearchBudget
} from './session-search-reconcile-budget'
import { runSessionSearchReconcileCycle } from './session-search-reconciler'
import {
  narrowsSessionSearchHistory,
  sessionSearchHistoryCutoffMs,
  widensSessionSearchHistory
} from './session-search-retention-policy'
import { removeSessionSearchDatabase } from './session-search-schema'
import type { SessionSearchScanRoots } from './session-search-scan-roots'
import { SessionSearchStore, STALE_PATH_LIMIT } from './session-search-store'
import { SessionSearchWorkLoop } from './session-search-work-loop'

/** Default cycle. Long enough that a machine with thousands of transcripts is
 * not re-statting continuously, short enough that a live conversation shows up
 * while the user is still in it. */
export const DEFAULT_SESSION_SEARCH_RECONCILE_INTERVAL_MS = 20_000
/** Newest-N per agent root: the same recency rule the session sidebar applies. */
export const DEFAULT_SESSION_SEARCH_RECENT_PER_AGENT = 12

export type SessionSearchIndexerOptions = {
  databasePath: string
  roots: SessionSearchScanRoots
  /** null = all history; otherwise only transcripts modified within this many days. */
  historyDays: number | null
  clock?: SessionSearchClock
  reconcileIntervalMs?: number
  recentPerAgent?: number
  budget?: SessionSearchBudget
  /** Test seam only; production shares the store's `STALE_PATH_LIMIT`. */
  pendingLimit?: number
  /** Stats one cycle spends proving deletions; the rest are checked next cycle. */
  retirementChecksPerCycle?: number
  /** Backfill pacing; tests replace it so a pass is not at the mercy of load. */
  pace?: (signal?: AbortSignal) => Promise<void>
  onError?: (error: unknown) => void
}

/**
 * Owns freshness for the index store: a whole-machine backfill, then a timer
 * that keeps the newest N transcripts per agent reconciled.
 *
 * A library, not a service. It knows nothing about Electron, the app lifecycle,
 * settings storage, IPC or the panel, and nothing here reads a setting or
 * registers itself anywhere. Whoever constructs it decides all of that.
 *
 * The guarantee it makes: while started, a transcript among the newest N per
 * agent that grows, is replaced or is deleted is reflected in the index within
 * one reconcile interval. Older files are reconciled on the next full sweep or
 * when a caller invalidates them.
 */
export class SessionSearchIndexer {
  private readonly clock: SessionSearchClock
  private readonly intervalMs: number
  private readonly recentPerAgent: number
  private readonly budget: SessionSearchBudget
  private readonly allowance: SessionSearchCycleAllowance
  private readonly indexingStatus = new SessionSearchIndexingStatus()
  private readonly pending: SessionSearchPendingFiles
  private readonly onError: (error: unknown) => void
  private readonly pace: (signal?: AbortSignal) => Promise<void>

  private readonly loop: SessionSearchWorkLoop
  private store: SessionSearchStore | null = null
  private unregister: (() => void) | null = null
  private previousRecent = new Set<string>()
  private rootFileCounts = new Map<string, number>()
  private historyDays: number | null
  private started = false
  private paused = false
  private pausedAt: number | null = null
  private fullSweepDue = false
  private closed = false

  constructor(private readonly options: SessionSearchIndexerOptions) {
    this.clock = options.clock ?? systemSessionSearchClock
    this.intervalMs = options.reconcileIntervalMs ?? DEFAULT_SESSION_SEARCH_RECONCILE_INTERVAL_MS
    this.recentPerAgent = options.recentPerAgent ?? DEFAULT_SESSION_SEARCH_RECENT_PER_AGENT
    this.budget = options.budget ?? DEFAULT_SESSION_SEARCH_BUDGET
    this.allowance = new SessionSearchCycleAllowance(this.budget)
    // One ceiling for both re-read queues, so a caller reading `droppedPending`
    // sees a single number that means one thing.
    this.pending = new SessionSearchPendingFiles(options.pendingLimit ?? STALE_PATH_LIMIT)
    this.onError = options.onError ?? ((error) => console.warn('[ai-vault-search]', error))
    this.pace = options.pace ?? pauseBackfill
    this.historyDays = options.historyDays
    this.loop = new SessionSearchWorkLoop({
      clock: this.clock,
      intervalMs: this.intervalMs,
      onFailure: (error) => {
        this.indexingStatus.failed()
        this.onError(error)
      },
      afterTask: () => this.publishPending()
    })
    this.openStore()
  }

  /** Runs a full sweep, then reconciles on the interval until paused or closed. */
  start(): Promise<void> {
    if (this.closed || this.started) {
      return this.loop.settled
    }
    this.started = true
    this.fullSweepDue = true
    return this.tick()
  }

  /** Stops the timer and the store's writers; queued work is kept, bounded. */
  pause(): void {
    if (this.paused || this.closed) {
      return
    }
    this.paused = true
    this.pausedAt = this.clock.now()
    this.indexingStatus.setPaused(true)
    this.loop.disarm()
    this.loop.abort()
    this.store?.setAcceptingWrites(false)
  }

  resume(): Promise<void> {
    if (!this.paused || this.closed) {
      return this.loop.settled
    }
    // A pause longer than one cycle means the recent-N window has moved on, so
    // the cheap re-stat can no longer prove what changed while nothing ran.
    const sincePause = this.pausedAt === null ? 0 : this.clock.now() - this.pausedAt
    this.paused = false
    this.pausedAt = null
    this.indexingStatus.setPaused(false)
    this.store?.setAcceptingWrites(true)
    this.fullSweepDue ||= sincePause > this.intervalMs
    return this.started ? this.tick() : this.loop.settled
  }

  /** Throws the index away and rebuilds it from scratch if the indexer is started. */
  clear(): Promise<void> {
    if (this.closed) {
      return this.loop.settled
    }
    this.loop.disarm()
    this.loop.abort()
    this.loop.queue(async () => {
      this.closeStore()
      removeSessionSearchDatabase(this.options.databasePath)
      this.pending.clear()
      this.previousRecent = new Set()
      this.openStore()
      this.fullSweepDue = true
    })
    return this.started && !this.paused ? this.tick() : this.loop.settled
  }

  /** Runs one pass now, off the timer. A full pass sweeps every root. */
  reconcile(options: { full?: boolean } = {}): Promise<void> {
    if (this.closed) {
      return this.loop.settled
    }
    this.fullSweepDue ||= options.full === true
    return this.tick()
  }

  /** Marks paths whose stored cursor is not to be trusted; the next cycle re-reads them whole. */
  invalidate(paths: readonly string[]): void {
    if (this.closed) {
      return
    }
    for (const path of paths) {
      this.pending.add({ path, candidate: null, forced: true })
    }
    this.publishPending()
  }

  /** Narrowing purges through the store; widening re-sweeps, because the files
   * outside the old bound were never read. */
  setHistoryDays(historyDays: number | null): Promise<void> {
    if (this.closed) {
      return this.loop.settled
    }
    const previous = this.historyDays
    this.historyDays = historyDays
    const cutoffMs = this.cutoffMs()
    this.store?.setRetentionCutoffMs(cutoffMs)
    if (narrowsSessionSearchHistory(previous, historyDays)) {
      return this.loop.queue(async (signal) => {
        await this.store?.purgeOlderThan(cutoffMs, signal)
      })
    }
    if (!widensSessionSearchHistory(previous, historyDays)) {
      return this.loop.settled
    }
    this.fullSweepDue = true
    return this.started && !this.paused ? this.tick() : this.loop.settled
  }

  status(): SessionSearchIndexStatus {
    this.publishPending()
    // Counted in the store, not tallied per attempt: an attempt counter reports
    // files the index does not hold, and reports them again next cycle.
    this.indexingStatus.setFilesIndexed(this.store?.indexedFileCount ?? 0)
    return this.indexingStatus.snapshot()
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.started = false
    this.indexingStatus.setClosed()
    this.loop.disarm()
    this.loop.abort()
    this.closeStore()
  }

  /** Tests only: everything else drives this through the timer. */
  settled(): Promise<void> {
    return this.loop.settled
  }

  private tick(): Promise<void> {
    return this.loop.queueThenArm(
      (signal) => this.pass(signal),
      () => this.started && !this.paused && !this.closed,
      () => void this.tick()
    )
  }

  private async pass(signal: AbortSignal): Promise<void> {
    const store = this.store
    if (!store || this.paused) {
      return
    }
    // The window moves with the clock, and every accept decision below reads it
    // from the store. Setting it once at construction leaves a sweep purging
    // rows that the very next candidate check happily re-indexes.
    const cutoffMs = this.cutoffMs()
    store.setRetentionCutoffMs(cutoffMs)
    if (this.fullSweepDue) {
      await this.sweep(store, cutoffMs, signal)
      return
    }
    await this.cycle(store, signal)
  }

  private async sweep(
    store: SessionSearchStore,
    cutoffMs: number | null,
    signal: AbortSignal
  ): Promise<void> {
    const sweep = await runSessionSearchBackfill({
      store,
      roots: this.options.roots,
      status: this.indexingStatus,
      cutoffMs,
      previousRootFileCounts: this.rootFileCounts,
      pace: this.pace,
      signal
    })
    this.rootFileCounts = sweep.rootFileCounts
    this.indexingStatus.setDegradedRoots(sweep.degradedRoots)
    if (!sweep.completed) {
      // A sweep is due until it finishes. Clearing the flag on entry meant a
      // pause part way through abandoned the rest of the machine's transcripts
      // until something else happened to ask for a full sweep.
      return
    }
    this.fullSweepDue = false
    // Watch everything the sweep saw: a transcript deleted between its
    // discovery and the first cycle is invisible to both otherwise. The
    // cycle's retirement cap keeps that one-off check off the critical path.
    this.previousRecent = sweep.watchPaths
    this.indexingStatus.sweepCompleted()
    this.indexingStatus.finishWork(this.clock.now())
  }

  private async cycle(store: SessionSearchStore, signal: AbortSignal): Promise<void> {
    this.allowance.reset()
    const cycle = await runSessionSearchReconcileCycle({
      store,
      roots: this.options.roots,
      status: this.indexingStatus,
      recentPerAgent: this.recentPerAgent,
      allowance: this.allowance,
      pending: this.pending.drain(),
      previousRecent: this.previousRecent,
      retirementChecksPerCycle: this.options.retirementChecksPerCycle,
      signal
    })
    // Work that was drained and then not read is a hole in the index, not
    // finished work, so an abort puts it back rather than dropping it.
    for (const entry of cycle.deferred) {
      this.pending.add(entry)
    }
    if (!cycle.completed) {
      return
    }
    this.previousRecent = cycle.recentPaths
    this.indexingStatus.setDegradedRoots(cycle.degradedRoots)
    this.indexingStatus.finishWork(this.clock.now())
  }

  private cutoffMs(): number | null {
    return sessionSearchHistoryCutoffMs(this.historyDays, this.clock.now())
  }

  private publishPending(): void {
    // Both queues, because a caller cannot act on one of them: the store's
    // re-read set and this indexer's roll-over queue are each bounded, and
    // either overrunning means the same thing for coverage.
    this.indexingStatus.setPending(
      this.pending.size + (this.store?.pendingFileCount ?? 0),
      this.pending.droppedCount + (this.store?.droppedPendingFileCount ?? 0)
    )
  }

  private openStore(): void {
    const store = new SessionSearchStore(this.options.databasePath, this.onError)
    store.setRetentionCutoffMs(this.cutoffMs())
    store.setAcceptingWrites(!this.paused)
    this.store = store
    this.unregister = registerSessionSearchIndexConsumer(store)
    this.indexingStatus.setRecoveredRows(store.recoveredWrites)
  }

  private closeStore(): void {
    this.unregister?.()
    this.unregister = null
    this.store?.close()
    this.store = null
  }
}
