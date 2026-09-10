import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { runSessionSearchBackfill } from './session-search-backfill'
import { systemSessionSearchClock, type SessionSearchClock } from './session-search-clock'
import {
  DEFAULT_SESSION_SEARCH_FULL_SWEEP_EVERY_CYCLES,
  DEFAULT_SESSION_SEARCH_PASS_DEADLINE_FRACTION,
  DEFAULT_SESSION_SEARCH_RECENT_PER_AGENT,
  DEFAULT_SESSION_SEARCH_RECONCILE_INTERVAL_MS,
  type SessionSearchIndexerOptions
} from './session-search-indexer-options'
import { SessionSearchDirectoryListings } from './session-search-directory-listings'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import {
  SessionSearchIndexingStatus,
  type SessionSearchIndexStatus
} from './session-search-indexing-status'
import { runSessionSearchReconcileCycle } from './session-search-reconciler'
import { sessionSearchHistoryCutoffMs } from './session-search-retention-policy'
import { SessionSearchStore } from './session-search-store'
import { SessionSearchWorkLoop } from './session-search-work-loop'

/**
 * Owns freshness for the index store: a whole-machine sweep, then a timer that
 * keeps the newest N transcripts per agent reconciled and sweeps again every
 * `fullSweepEveryCycles`.
 *
 * A library, not a service. It knows nothing about Electron, the app lifecycle,
 * settings storage, IPC or the panel, and nothing here reads a setting or
 * registers itself anywhere. Whoever constructs it decides all of that.
 *
 * **Immutable after construction.** There is no `pause`, `resume`, `clear` or
 * `setHistoryDays`: every one of those was a second lifetime for the store, the
 * queue and the sweep flag inside one object, and four review rounds of findings
 * were seams between them. A configuration change is `close()` and a new
 * instance; throwing the index away is
 * `close(); removeSessionSearchDatabase(databasePath);` and a new instance.
 * Widening retention is a new instance whose opening sweep admits the older
 * files; narrowing is the purge that opens every full sweep.
 *
 * The guarantee it makes: while started, a transcript among the newest N per
 * agent that grows, is replaced or is deleted is reflected in the index within
 * one reconcile interval. Everything else is reached by the periodic sweep.
 *
 * Every pass stops at one wall-clock deadline and hands the rest back, so an
 * unasked background index cannot own the process for as long as the disk is
 * large.
 */
export class SessionSearchIndexer {
  private readonly clock: SessionSearchClock
  private readonly intervalMs: number
  private readonly passDeadlineMs: number
  private readonly recentPerAgent: number
  private readonly fullSweepEveryCycles: number
  private readonly indexingStatus = new SessionSearchIndexingStatus()
  private readonly onError: (error: unknown) => void

  private readonly loop: SessionSearchWorkLoop
  private readonly store: SessionSearchStore
  private readonly unregister: () => void
  private previousRecent: ReadonlySet<string> = new Set()
  /** Null until a pass has recorded one; an empty set is a real observation. */
  private previousRootsWithFiles: ReadonlySet<string> | null = null
  private cyclesSinceSweep = 0
  private fullSweepDue = false
  private started = false
  private closed = false

  constructor(private readonly options: SessionSearchIndexerOptions) {
    this.clock = options.clock ?? systemSessionSearchClock
    this.intervalMs = options.reconcileIntervalMs ?? DEFAULT_SESSION_SEARCH_RECONCILE_INTERVAL_MS
    this.passDeadlineMs =
      options.passDeadlineMs ??
      Math.max(1, Math.floor(this.intervalMs / DEFAULT_SESSION_SEARCH_PASS_DEADLINE_FRACTION))
    this.recentPerAgent = options.recentPerAgent ?? DEFAULT_SESSION_SEARCH_RECENT_PER_AGENT
    this.fullSweepEveryCycles = Math.max(
      1,
      options.fullSweepEveryCycles ?? DEFAULT_SESSION_SEARCH_FULL_SWEEP_EVERY_CYCLES
    )
    this.onError = options.onError ?? ((error) => console.warn('[ai-vault-search]', error))
    this.loop = new SessionSearchWorkLoop({
      clock: this.clock,
      intervalMs: this.intervalMs,
      onFailure: (error) => {
        this.indexingStatus.failed()
        this.onError(error)
      }
    })
    // Store, registration and indexer share one lifetime, which is what makes
    // the object immutable: there is no second open to get out of step with.
    this.store = new SessionSearchStore(options.databasePath, this.onError)
    this.store.setRetentionCutoffMs(this.cutoffMs())
    this.unregister = registerSessionSearchIndexConsumer(this.store)
  }

  /** Runs a full sweep, then reconciles on the interval until closed. */
  start(): Promise<void> {
    if (this.closed || this.started) {
      return this.loop.settled
    }
    this.started = true
    this.fullSweepDue = true
    this.indexingStatus.setStarted()
    return this.tick()
  }

  /**
   * Runs one pass now, off the timer. A full pass sweeps every root.
   *
   * Refused before `start()` and after `close()`: a pass against an indexer
   * nobody started writes the index once and leaves it to go stale with no
   * timer armed to notice the next change, and a pass against a closed one has
   * no store to write to. Both are caller bugs, so both throw rather than
   * resolving as though a pass had run.
   */
  reconcile(options: { full?: boolean } = {}): Promise<void> {
    if (this.closed) {
      throw new Error('SessionSearchIndexer.reconcile: the indexer is closed')
    }
    if (!this.started) {
      throw new Error('SessionSearchIndexer.reconcile: start() first')
    }
    this.fullSweepDue ||= options.full === true
    return this.tick()
  }

  status(): SessionSearchIndexStatus {
    // Counted in the store, not tallied per attempt: an attempt counter reports
    // files the index does not hold, and reports them again next cycle.
    this.indexingStatus.setFilesIndexed(this.store.indexedFileCount)
    this.indexingStatus.setPending(this.store.pendingFileCount, this.store.droppedPendingFileCount)
    return this.indexingStatus.snapshot()
  }

  /** Stops everything. Nothing queued before this call may run afterwards. */
  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.indexingStatus.setClosed()
    // The loop, not just its timer: a task queued before this call would
    // otherwise still run against a store this line is about to close.
    this.loop.close()
    this.unregister()
    this.store.close()
  }

  /** Tests only: everything else drives this through the timer. */
  settled(): Promise<void> {
    return this.loop.settled
  }

  private tick(): Promise<void> {
    return this.loop.queue(
      (signal) => this.pass(signal),
      () => void this.tick()
    )
  }

  private async pass(signal: AbortSignal): Promise<void> {
    // The window moves with the clock, and every accept decision below reads it
    // from the store. Setting it once at construction leaves a sweep purging
    // rows that the very next candidate check happily re-indexes.
    const cutoffMs = this.cutoffMs()
    this.store.setRetentionCutoffMs(cutoffMs)
    // One readdir per directory for the whole pass, shared by everything in it.
    const listings = new SessionSearchDirectoryListings()
    // The one bound on a pass: wall time. What it does not reach goes back on
    // the queue at full speed rather than being read slowly.
    const startedAt = this.clock.now()
    const overdue = (): boolean => this.clock.now() - startedAt >= this.passDeadlineMs
    if (this.fullSweepDue) {
      // Cleared before the sweep runs, not after: an explicit
      // `reconcile({ full: true })` raised while this one is in flight sets the
      // flag again, and clearing it on the way out would erase that request
      // along with this pass's own. An unfinished sweep sets it back itself.
      this.fullSweepDue = false
      await this.sweep(cutoffMs, listings, overdue, signal)
      return
    }
    await this.cycle(listings, overdue, signal)
  }

  private async sweep(
    cutoffMs: number | null,
    listings: SessionSearchDirectoryListings,
    overdue: () => boolean,
    signal: AbortSignal
  ): Promise<void> {
    const sweep = await runSessionSearchBackfill({
      store: this.store,
      roots: this.options.roots,
      status: this.indexingStatus,
      cutoffMs,
      previousRootsWithFiles: this.previousRootsWithFiles ?? undefined,
      listings,
      overdue,
      signal
    })
    this.indexingStatus.sweepFinished(sweep.completed)
    this.requeue(sweep.deferred)
    if (!sweep.completed) {
      // A sweep stays due until one finishes: an aborted one saw part of the
      // machine, so it learned nothing about root health or orphans, and
      // publishing its empty findings would clear a live alarm.
      this.fullSweepDue = true
      return
    }
    // Only what this sweep could not settle. A file it discovered and proved
    // present needs no watching: the recency window covers the ones that
    // change, and an old file deleted later is the next sweep's to find.
    this.previousRecent = sweep.watchPaths
    this.previousRootsWithFiles = sweep.rootsWithFiles
    this.cyclesSinceSweep = 0
    this.indexingStatus.finishWork(this.clock.now())
  }

  private async cycle(
    listings: SessionSearchDirectoryListings,
    overdue: () => boolean,
    signal: AbortSignal
  ): Promise<void> {
    const cycle = await runSessionSearchReconcileCycle({
      store: this.store,
      roots: this.options.roots,
      status: this.indexingStatus,
      recentPerAgent: this.recentPerAgent,
      overdue,
      previousRecent: this.previousRecent,
      retirementChecksPerCycle: this.options.retirementChecksPerCycle,
      previousRootsWithFiles: this.previousRootsWithFiles ?? undefined,
      listings,
      signal
    })
    this.requeue(cycle.deferred)
    if (!cycle.completed) {
      return
    }
    this.previousRecent = cycle.recentPaths
    this.previousRootsWithFiles = cycle.rootsWithFiles
    // A root that came back, a tree restored from a backup, an old transcript
    // deleted: only a sweep sees any of it, and the cadence is what replaces
    // every rule that tried to guess when one was owed.
    this.cyclesSinceSweep += 1
    if (this.cyclesSinceSweep >= this.fullSweepEveryCycles) {
      this.fullSweepDue = true
    }
    this.indexingStatus.finishWork(this.clock.now())
  }

  /**
   * Work drained and not read goes back on the queue, because a drained entry
   * nobody read is a hole in the index rather than finished work. The store's
   * re-read set is the one queue: it already bounds itself, drops the oldest
   * first and counts the drops, and it is where a declined read lands too.
   */
  private requeue(candidates: readonly SessionFileCandidate[]): void {
    for (const candidate of candidates) {
      this.store.markStale(candidate)
    }
  }

  private cutoffMs(): number | null {
    return sessionSearchHistoryCutoffMs(this.options.historyDays, this.clock.now())
  }
}
