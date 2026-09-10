import { runSessionSearchBackfill } from './session-search-backfill'
import { SessionSearchBackfillRemainder } from './session-search-backfill-remainder'
import { pauseBackfill } from './session-search-backfill-pacing'
import { systemSessionSearchClock, type SessionSearchClock } from './session-search-clock'
import {
  DEFAULT_SESSION_SEARCH_RECENT_PER_AGENT,
  DEFAULT_SESSION_SEARCH_RECONCILE_INTERVAL_MS,
  type SessionSearchIndexerOptions
} from './session-search-indexer-options'
import { SessionSearchDirectoryListings } from './session-search-directory-listings'
import {
  SessionSearchIndexingStatus,
  type SessionSearchIndexStatus
} from './session-search-indexing-status'
import {
  DEFAULT_SESSION_SEARCH_PENDING_LIMIT,
  sessionSearchOwedFiles,
  SessionSearchPendingFiles
} from './session-search-pending-files'
import {
  DEFAULT_SESSION_SEARCH_BACKFILL_BUDGET,
  DEFAULT_SESSION_SEARCH_BUDGET,
  SessionSearchCycleAllowance
} from './session-search-reconcile-budget'
import { runSessionSearchReconcileCycle } from './session-search-reconciler'
import { SessionSearchRetentionWindow } from './session-search-retention-policy'
import { SessionSearchRootRecovery } from './session-search-root-recovery'
import { SessionSearchRegisteredStore } from './session-search-registered-store'
import type { SessionSearchStore } from './session-search-store'
import { SessionSearchWorkLoop } from './session-search-work-loop'

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
 *
 * Every pass that reads transcript bytes is budgeted, the backfill included, so
 * there is no pass that can own the process for as long as the disk is large.
 */
export class SessionSearchIndexer {
  private readonly clock: SessionSearchClock
  private readonly intervalMs: number
  private readonly recentPerAgent: number
  private readonly allowance: SessionSearchCycleAllowance
  private readonly backfillAllowance: SessionSearchCycleAllowance
  private readonly indexingStatus = new SessionSearchIndexingStatus()
  private readonly pending: SessionSearchPendingFiles
  private readonly onError: (error: unknown) => void
  private readonly pace: (signal?: AbortSignal) => Promise<void>

  private readonly loop: SessionSearchWorkLoop
  private readonly registered: SessionSearchRegisteredStore
  private previousRecent = new Set<string>()
  private readonly rootRecovery = new SessionSearchRootRecovery()
  private readonly backfillRemainder = new SessionSearchBackfillRemainder()
  private readonly retention: SessionSearchRetentionWindow
  private started = false
  private paused = false
  private purgeDue = false
  private fullSweepDue = false
  private closed = false

  constructor(private readonly options: SessionSearchIndexerOptions) {
    this.clock = options.clock ?? systemSessionSearchClock
    this.intervalMs = options.reconcileIntervalMs ?? DEFAULT_SESSION_SEARCH_RECONCILE_INTERVAL_MS
    this.recentPerAgent = options.recentPerAgent ?? DEFAULT_SESSION_SEARCH_RECENT_PER_AGENT
    this.allowance = new SessionSearchCycleAllowance(
      options.budget ?? DEFAULT_SESSION_SEARCH_BUDGET
    )
    this.backfillAllowance = new SessionSearchCycleAllowance(
      options.backfillBudget ?? DEFAULT_SESSION_SEARCH_BACKFILL_BUDGET
    )
    this.pending = new SessionSearchPendingFiles(
      options.pendingLimit ?? DEFAULT_SESSION_SEARCH_PENDING_LIMIT
    )
    this.onError = options.onError ?? ((error) => console.warn('[ai-vault-search]', error))
    this.pace = options.pace ?? pauseBackfill
    this.registered = new SessionSearchRegisteredStore(options.databasePath, this.onError)
    this.retention = new SessionSearchRetentionWindow(options.historyDays)
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
    this.indexingStatus.setStarted()
    // Started while paused: `resume()` is what arms the timer. Queueing a pass
    // that returns immediately would resolve this call as though one had run.
    return this.paused ? this.loop.settled : this.tick()
  }

  /** Stops the timer and the store's writers; queued work is kept, bounded. */
  pause(): void {
    if (this.paused || this.closed) {
      return
    }
    this.paused = true
    this.indexingStatus.setPaused(true)
    this.loop.disarm()
    this.loop.abort()
    this.store?.setAcceptingWrites(false)
  }

  /**
   * Lets the timer run again. It does not sweep on its own, however long the
   * pause was: the reader records every read it declined while paused in the
   * store's re-read set, and the next cycle drains that set alongside the
   * recency window. A sweep is for reaching files nothing has told us about,
   * which is not what a pause produces.
   */
  resume(): Promise<void> {
    if (!this.paused || this.closed) {
      return this.loop.settled
    }
    this.paused = false
    this.indexingStatus.setPaused(false)
    this.store?.setAcceptingWrites(true)
    return this.started ? this.tick() : this.loop.settled
  }

  /** Throws the index away and rebuilds it from scratch if the indexer is started. */
  clear(): Promise<void> {
    if (this.closed) {
      return this.loop.settled
    }
    this.loop.disarm()
    this.loop.abort()
    // Recorded before it is queued: `close()` performs whatever is still owed,
    // because a caller who asked for the index to be thrown away and got a
    // resolved promise back must not be left with the database on disk.
    this.registered.requestRemoval()
    this.loop.queue(async () => {
      this.registered.close()
      this.pending.clear()
      this.previousRecent = new Set()
      this.rootRecovery.reset()
      this.backfillRemainder.clear()
      this.indexingStatus.forgetSweep()
      this.openStore()
      this.fullSweepDue = true
    })
    return this.started && !this.paused ? this.tick() : this.loop.settled
  }

  /**
   * Runs one pass now, off the timer. A full pass sweeps every root.
   *
   * Refused before `start()`. A pass run against an indexer nobody started
   * writes the index once and then leaves it to go stale, because there is no
   * timer to arm and nothing to notice the next change; a caller that wants one
   * pass wants `start()`.
   */
  reconcile(options: { full?: boolean } = {}): Promise<void> {
    if (this.closed || !this.started) {
      return this.loop.settled
    }
    this.fullSweepDue ||= options.full === true
    return this.paused ? this.loop.settled : this.tick()
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

  /**
   * Narrowing purges through the store; widening re-sweeps, because the files
   * outside the old bound were never read.
   *
   * A purge is an index write, so a paused indexer records that one is owed and
   * runs it on the first pass that is allowed to write. Deleting rows and
   * compacting the database while the caller has asked for quiet is exactly the
   * work a pause exists to stop.
   */
  setHistoryDays(historyDays: number | null): Promise<void> {
    if (this.closed) {
      return this.loop.settled
    }
    const change = this.retention.moveTo(historyDays)
    const cutoffMs = this.cutoffMs()
    this.store?.setRetentionCutoffMs(cutoffMs)
    if (change === 'purge') {
      if (this.paused) {
        this.purgeDue = true
        return this.loop.settled
      }
      return this.loop.queue(async (signal) => {
        await this.store?.purgeOlderThan(cutoffMs, signal)
      })
    }
    if (change !== 'resweep') {
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
    // The loop, not just its timer: a task queued before this call would
    // otherwise still run, and `clear()`'s task reopens the store. Closing the
    // loop makes every queued task a no-op, so nothing can register a consumer
    // or open a database against an indexer the caller has finished with.
    // The store, its registration, and a removal a queued `clear()` will now
    // never perform, because closing the loop is what stops that task running.
    this.loop.close()
    this.registered.close()
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
    const purgeDue = this.purgeDue
    this.purgeDue = false
    // One readdir per directory for the whole pass, shared by everything in it.
    const listings = new SessionSearchDirectoryListings()
    // A pass may hold the loop for one interval and no longer. The allowance
    // bounds bytes; this bounds wall time, which is what the pacer's load
    // back-off spends without spending a single byte of budget.
    const startedAt = this.clock.now()
    const overdue = (): boolean => this.clock.now() - startedAt >= this.intervalMs
    if (this.fullSweepDue) {
      // Cleared before the sweep runs, not after: a widening or an explicit
      // `reconcile({ full: true })` raised while this one is in flight sets the
      // flag again, and clearing it on the way out would erase that request
      // along with this pass's own. An unfinished sweep sets it back itself.
      this.fullSweepDue = false
      // A sweep opens with a purge of its own; running one here first would
      // compact the database twice for the same narrowing.
      await this.sweep(store, cutoffMs, listings, overdue, signal)
      return
    }
    if (purgeDue) {
      await store.purgeOlderThan(cutoffMs, signal)
    }
    await this.cycle(store, listings, overdue, signal)
  }

  private async sweep(
    store: SessionSearchStore,
    cutoffMs: number | null,
    listings: SessionSearchDirectoryListings,
    overdue: () => boolean,
    signal: AbortSignal
  ): Promise<void> {
    const sweep = await runSessionSearchBackfill({
      store,
      roots: this.options.roots,
      status: this.indexingStatus,
      cutoffMs,
      previousRootsWithFiles: this.rootRecovery.previousRootsWithFiles,
      allowance: this.backfillAllowance,
      listings,
      overdue,
      pace: this.pace,
      signal
    })
    this.indexingStatus.sweepFinished(sweep.completed)
    if (!sweep.completed) {
      this.fullSweepDue = true
      // An aborted sweep saw part of the machine, so it learned nothing about
      // root health or orphans. Publishing its empty findings would clear a
      // live alarm.
      //
      // A sweep also stays due until it finishes: clearing the flag on entry
      // meant a pause part way through abandoned the rest of the machine's
      // transcripts until something else happened to ask for a full sweep.
      return
    }
    // Only what this sweep could not settle. A file it discovered and proved
    // present needs no watching: the recency window covers the ones that
    // change, and an old file deleted later is the next sweep's to find.
    this.previousRecent = sweep.watchPaths
    // A sweep never arms off its own observation; see the recovery module.
    this.rootRecovery.observe(sweep.rootsWithFiles, false)
    this.backfillRemainder.remember(sweep.deferred)
    this.indexingStatus.finishWork(this.clock.now())
  }

  private async cycle(
    store: SessionSearchStore,
    listings: SessionSearchDirectoryListings,
    overdue: () => boolean,
    signal: AbortSignal
  ): Promise<void> {
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
      previousRootsWithFiles: this.rootRecovery.previousRootsWithFiles,
      listings,
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
    this.fullSweepDue ||= this.rootRecovery.observe(cycle.rootsWithFiles, true)
    this.fullSweepDue ||= await this.backfillRemainder.drain(
      store,
      this.backfillAllowance,
      this.indexingStatus,
      this.pace,
      signal,
      overdue
    )
    this.indexingStatus.finishWork(this.clock.now())
  }

  private cutoffMs(): number | null {
    return this.retention.cutoffMs(this.clock.now())
  }

  private publishPending(): void {
    const owed = sessionSearchOwedFiles(
      this.store,
      [this.pending.paths, this.backfillRemainder.paths],
      this.pending.droppedCount
    )
    this.indexingStatus.setPending(owed.pending, owed.dropped)
  }

  private get store(): SessionSearchStore | null {
    return this.registered.current
  }

  private openStore(): void {
    const store = this.registered.open(this.cutoffMs(), !this.paused)
    this.indexingStatus.setRecoveredRows(store.recoveredWrites)
  }
}
