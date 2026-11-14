import { resolve } from 'node:path'
import { systemSessionSearchClock, type SessionSearchClock } from './session-search-clock'
import { waitForAiVaultScan } from '../../ai-vault/scan-lifecycle/ai-vault-scan-cancellation'
import {
  DEFAULT_SESSION_SEARCH_FULL_SWEEP_EVERY_CYCLES,
  sessionSearchPassDeadlineMs,
  DEFAULT_SESSION_SEARCH_RECENT_PER_AGENT,
  DEFAULT_SESSION_SEARCH_RECONCILE_INTERVAL_MS,
  type SessionSearchIndexerOptions
} from './session-search-indexer-options'
import { SessionSearchDirectoryListings } from '../discovery/session-search-directory-listings'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { runSessionSearchPass, SessionSearchPassState } from './session-search-pass'
import { sessionSearchHistoryCutoffMs } from '../session-search-retention-policy'
import type { SessionSearchStateCounts } from '../storage/session-search-store-types'
import { SessionSearchWorkerStore } from '../worker/session-search-worker-store'
import type { SessionSearchDegradedRoot } from '../discovery/session-search-degraded-roots'
import {
  sessionSearchIndexStatus,
  readSessionSearchCounts,
  type SessionSearchIndexStatus
} from './session-search-indexer-status'
export type {
  SessionSearchIndexPhase,
  SessionSearchIndexStatus
} from './session-search-indexer-status'
import { runSessionSearchPeriodicPass } from './session-search-periodic-pass'
import { SessionSearchWorkLoop } from './session-search-work-loop'

// Duplicate indexers would register competing consumers and fence each other’s writes.
const liveIndexerPaths = new Set<string>()

/** Reconfigure by closing and constructing anew; persisted file rows determine which reads are owed. */
export class SessionSearchIndexer {
  private roots: SessionSearchIndexerOptions['roots']
  private readonly ownershipPath: string
  private readonly clock: SessionSearchClock
  private readonly passDeadlineMs: number
  private readonly recentPerAgent: number
  private readonly fullSweepEveryCycles: number
  private readonly onError: (error: unknown) => void

  private readonly loop: SessionSearchWorkLoop
  private readonly store: SessionSearchWorkerStore
  private readonly unregister: () => void
  /** Null means unobserved; an empty set records a real pass. */
  private previousRootsWithFiles: ReadonlySet<string> | null = null
  private degradedRoots: SessionSearchDegradedRoot[] = []
  private lastReconcileAt: number | null = null
  private lastSweepCompletedAt: number | null = null
  /** Deferred candidates outside the database’s due-row count. */
  private left = 0
  private lastCounts: SessionSearchStateCounts | null = null
  private cyclesSinceSweep = 0
  private sweepNext = false
  /** Retention/root maintenance is independent of unfinished discovery and reads. */
  private maintenanceNext = false
  private primaryWakeNext: number | undefined
  private primaryWakeRevision = 0
  private sweepInProgress = false
  private retirement: Promise<void> | null = null
  private readonly work: SessionSearchPassState | undefined
  private started = false
  private closed = false

  constructor(private readonly options: SessionSearchIndexerOptions) {
    this.roots = options.roots
    this.ownershipPath = resolve(options.databasePath)
    this.clock = options.clock ?? systemSessionSearchClock
    const intervalMs = options.reconcileIntervalMs ?? DEFAULT_SESSION_SEARCH_RECONCILE_INTERVAL_MS
    this.passDeadlineMs = sessionSearchPassDeadlineMs(intervalMs, options.passDeadlineMs)
    this.recentPerAgent = options.recentPerAgent ?? DEFAULT_SESSION_SEARCH_RECENT_PER_AGENT
    this.fullSweepEveryCycles = Math.max(
      1,
      options.fullSweepEveryCycles ?? DEFAULT_SESSION_SEARCH_FULL_SWEEP_EVERY_CYCLES
    )
    this.onError = options.onError ?? ((error) => console.warn('[ai-vault-search]', error))
    this.loop = new SessionSearchWorkLoop({
      clock: this.clock,
      intervalMs,
      onFailure: this.onError
    })
    if (liveIndexerPaths.has(this.ownershipPath)) {
      throw new Error(
        `SessionSearchIndexer: ${options.databasePath} already has a live indexer; close it first`
      )
    }
    // Claim ownership before async initialization so another indexer cannot race the writer open.
    this.work =
      options.discoveryPolicy === 'event-led'
        ? new SessionSearchPassState(options.watcherEntryPath)
        : undefined
    this.store = new SessionSearchWorkerStore(
      options.databasePath,
      this.onError,
      () => {
        this.sweepNext = true
      },
      (path) => {
        const row = this.store.fileRow(path)
        this.work?.candidates.rowChanged(path, row)
      }
    )
    liveIndexerPaths.add(this.ownershipPath)
    this.store.setRetentionCutoffMs(this.cutoffMs())
    this.unregister = registerSessionSearchIndexConsumer(this.store, this.work?.candidates)
  }

  start(): Promise<void> {
    if (this.closed || this.started) {
      return this.loop.settled
    }
    this.started = true
    this.sweepNext = true
    this.maintenanceNext = true
    return this.tick()
  }

  reconcile(options: { full?: boolean } = {}): Promise<void> {
    if (this.closed) {
      throw new Error('SessionSearchIndexer.reconcile: the indexer is closed')
    }
    if (!this.started) {
      throw new Error('SessionSearchIndexer.reconcile: start() first')
    }
    if (options.full === true) {
      this.sweepNext = true
      this.maintenanceNext = true
      this.primaryWakeNext = ++this.primaryWakeRevision
    }
    return this.tick()
  }

  generation(): number {
    return this.store.generation
  }

  status(): SessionSearchIndexStatus {
    return sessionSearchIndexStatus(this.closed ? this.lastCounts : this.readCounts(), {
      closed: this.closed,
      started: this.started,
      left: this.left,
      pending: () => this.left > 0 || !!this.work?.pending,
      degradedRoots: this.degradedRoots,
      lastReconcileAt: this.lastReconcileAt,
      lastSweepCompletedAt: this.lastSweepCompletedAt
    })
  }

  close(): Promise<void> {
    if (this.closed) {
      return this.retired()
    }
    this.lastCounts = this.readCounts() ?? this.lastCounts
    this.closed = true
    this.loop.close()
    this.unregister()
    this.store.close()
    this.retirement = Promise.all([
      this.store.retired(),
      this.work?.close(),
      this.loop.settled
    ]).then(() => {
      liveIndexerPaths.delete(this.ownershipPath)
    })
    return this.retirement
  }

  async initialize(): Promise<void> {
    try {
      await this.store.prepare()
    } catch (error) {
      await this.close()
      throw error
    }
  }

  retired(): Promise<void> {
    return this.retirement ?? this.store.retired()
  }

  settled(): Promise<void> {
    return this.loop.settled.then(() => this.store.flush())
  }

  private readCounts(): SessionSearchStateCounts | null {
    return (this.lastCounts = readSessionSearchCounts(this.store, this.lastCounts, this.onError))
  }

  private tick(): Promise<void> {
    return this.loop.queue(
      (signal) => this.pass(signal),
      () => void this.tick()
    )
  }

  private pass(signal: AbortSignal): Promise<void> {
    return this.work ? this.eventPass(signal, this.work) : this.periodicPass(signal)
  }

  private async periodicPass(signal: AbortSignal): Promise<void> {
    this.store.setRetentionCutoffMs(this.cutoffMs())
    const startedAt = this.clock.now()
    const full = this.sweepNext
    this.sweepNext = false
    try {
      if (full && this.options.resolveRoots) {
        const roots = await waitForAiVaultScan(this.options.resolveRoots(signal), signal)
        if (signal.aborted) {
          return
        }
        this.roots = roots
      }
      const result = await runSessionSearchPeriodicPass({
        store: this.store,
        roots: this.roots,
        full,
        recentPerAgent: this.recentPerAgent,
        previousRootsWithFiles: this.previousRootsWithFiles ?? undefined,
        overdue: () => this.clock.now() - startedAt >= this.passDeadlineMs,
        listings: new SessionSearchDirectoryListings(),
        signal
      })
      if (!result.completed) {
        this.sweepNext ||= full
        return
      }
      this.degradedRoots = result.degradedRoots
      this.previousRootsWithFiles = result.rootsWithFiles
      this.lastReconcileAt = this.clock.now()
      this.left = result.left
      this.sweepNext ||= result.outOfTime
      if (full) {
        if (!result.outOfTime) {
          this.lastSweepCompletedAt = this.lastReconcileAt
        }
        this.cyclesSinceSweep = 0
        return
      }
      if (++this.cyclesSinceSweep >= this.fullSweepEveryCycles) {
        this.sweepNext = true
      }
    } catch (error) {
      this.sweepNext ||= full
      throw error
    }
  }

  private async eventPass(signal: AbortSignal, work: SessionSearchPassState): Promise<void> {
    this.store.setRetentionCutoffMs(this.cutoffMs())
    const primaryWake = this.primaryWakeNext
    const full = this.sweepNext
    const maintenance = this.maintenanceNext || full
    this.sweepNext = false
    this.maintenanceNext = maintenance
    this.sweepInProgress ||= full
    let discoveryAccepted = false
    try {
      if (maintenance && this.options.resolveRoots) {
        const roots = await waitForAiVaultScan(this.options.resolveRoots(signal), signal)
        if (signal.aborted) {
          return
        }
        this.roots = roots
      }
      const discoveryStarted = this.clock.now()
      const result = await runSessionSearchPass({
        store: this.store,
        state: work,
        roots: this.roots,
        full,
        primaryWake,
        onDiscoveryBegin: () => {
          discoveryAccepted = true
        },
        purge: maintenance,
        onPurged: () => {
          this.maintenanceNext = false
        },
        recentPerAgent: this.recentPerAgent,
        previousRootsWithFiles: this.previousRootsWithFiles ?? undefined,
        discoveryOverdue: () =>
          this.clock.now() - discoveryStarted >=
          (this.options.discoveryDeadlineMs ?? this.passDeadlineMs),
        startReadDeadline: () => {
          const readsStartedAt = this.clock.now()
          return () => this.clock.now() - readsStartedAt >= this.passDeadlineMs
        },
        listings: new SessionSearchDirectoryListings(),
        signal
      })
      if (!result.completed) {
        return
      }
      if (this.primaryWakeNext === primaryWake) {
        this.primaryWakeNext = undefined
      }
      this.degradedRoots = result.degradedRoots
      this.previousRootsWithFiles = result.rootsWithFiles
      this.lastReconcileAt = this.clock.now()
      this.left = result.left
      if (this.sweepInProgress && !result.pending) {
        this.lastSweepCompletedAt = this.lastReconcileAt
        this.sweepInProgress = false
      }
      this.cyclesSinceSweep++
      if (this.cyclesSinceSweep >= this.fullSweepEveryCycles) {
        this.maintenanceNext = true
        this.primaryWakeNext = ++this.primaryWakeRevision
        this.cyclesSinceSweep = 0
      }
    } catch (error) {
      // The owned frontiers retain progress; a failure never promotes continuation into discovery.
      if (!signal.aborted) {
        throw error
      }
    } finally {
      this.sweepNext ||= full && !discoveryAccepted
    }
  }

  private cutoffMs(): number | null {
    return sessionSearchHistoryCutoffMs(this.options.historyDays, this.clock.now())
  }
}
