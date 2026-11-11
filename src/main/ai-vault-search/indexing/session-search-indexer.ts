import { systemSessionSearchClock, type SessionSearchClock } from './session-search-clock'
import { waitForAiVaultScan } from '../../ai-vault/ai-vault-scan-cancellation'
import {
  DEFAULT_SESSION_SEARCH_FULL_SWEEP_EVERY_CYCLES,
  DEFAULT_SESSION_SEARCH_PASS_DEADLINE_FRACTION,
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
import { SessionSearchWorkLoop } from './session-search-work-loop'

// Duplicate indexers would register competing consumers and fence each other’s writes.
const liveIndexerPaths = new Set<string>()

export type SessionSearchIndexPhase = 'idle' | 'indexing' | 'current' | 'degraded' | 'closed'

export type SessionSearchIndexStatus = {
  phase: SessionSearchIndexPhase
  /** Rows indexed through the file stat they record. */
  filesIndexed: number
  /** Due rows plus unread candidates deferred by the last pass, which may have no row yet. */
  filesDue: number
  /** Rows whose last read did not commit. */
  filesFailed: number
  messagesIndexed: number
  degradedRoots: SessionSearchDegradedRoot[]
  lastReconcileAt: number | null
  /** Last full sweep with no deferred reads; null until one completes. */
  lastSweepCompletedAt: number | null
  sessionsByAgent: Record<string, number>
}

/** Reconfigure by closing and constructing anew; persisted file rows determine which reads are owed. */
export class SessionSearchIndexer {
  private roots: SessionSearchIndexerOptions['roots']
  private readonly ownershipPath: string
  private readonly clock: SessionSearchClock
  private readonly intervalMs: number
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
  private readonly work: SessionSearchPassState
  private started = false
  private closed = false

  constructor(private readonly options: SessionSearchIndexerOptions) {
    this.roots = options.roots
    this.ownershipPath = resolve(options.databasePath)
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
    const onError = options.onError ?? ((error) => console.warn('[ai-vault-search]', error))
    this.onError = onError
    this.loop = new SessionSearchWorkLoop({
      clock: this.clock,
      intervalMs: this.intervalMs,
      onFailure: onError
    })
    if (liveIndexerPaths.has(this.ownershipPath)) {
      throw new Error(
        `SessionSearchIndexer: ${options.databasePath} already has a live indexer; close it first`
      )
    }
    // Claim ownership before async initialization so another indexer cannot race the writer open.
    this.work = new SessionSearchPassState(options.watcherEntryPath)
    this.store = new SessionSearchWorkerStore(
      options.databasePath,
      onError,
      () => {
        this.sweepNext = true
      },
      (path) => {
        const row = this.store.fileRow(path)
        this.work.candidates.rowChanged(path, row)
      }
    )
    liveIndexerPaths.add(this.ownershipPath)
    this.store.setRetentionCutoffMs(this.cutoffMs())
    this.unregister = registerSessionSearchIndexConsumer(this.store, this.work.candidates)
  }

  /** Begin inventory capture, then consume changes and retained debt at the normal cadence. */
  start(): Promise<void> {
    if (this.closed || this.started) {
      return this.loop.settled
    }
    this.started = true
    this.sweepNext = true
    this.maintenanceNext = true
    return this.tick()
  }

  /** Queue a pass now; requires a started, open indexer. */
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
    // Use cached counts after close to avoid reading a shut database.
    const settled = (this.closed ? this.lastCounts : this.readCounts()) ?? {
      current: 0,
      due: 0,
      failed: 0,
      sessionsByAgent: {},
      messages: 0
    }
    return {
      phase: this.phase(settled),
      filesIndexed: settled.current,
      filesDue: settled.due + this.left,
      filesFailed: settled.failed,
      messagesIndexed: settled.messages,
      degradedRoots: this.degradedRoots.map((root) => ({ ...root })),
      lastReconcileAt: this.lastReconcileAt,
      lastSweepCompletedAt: this.lastSweepCompletedAt,
      sessionsByAgent: { ...settled.sessionsByAgent }
    }
  }

  close(): Promise<void> {
    if (this.closed) {
      return this.retired()
    }
    // Preserve final counts for status calls after the store closes.
    this.lastCounts = this.readCounts() ?? this.lastCounts
    this.closed = true
    // Cancel queued and in-flight passes before closing their store.
    this.loop.close()
    this.unregister()
    this.store.close()
    this.retirement = Promise.all([
      this.store.retired(),
      this.work.close(),
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
    try {
      const counts = this.store.stateCounts()
      this.lastCounts = counts
      return counts
    } catch (error) {
      this.onError(error)
      return this.lastCounts
    }
  }

  private phase(counts: SessionSearchStateCounts): SessionSearchIndexPhase {
    if (this.closed) {
      return 'closed'
    }
    if (!this.started) {
      return 'idle'
    }
    if (this.degradedRoots.length > 0 || counts.failed > 0) {
      return 'degraded'
    }
    // Deferred candidates may have no rows, so due-row counts alone cannot prove completion.
    if (this.left > 0 || this.work.pending) {
      return 'indexing'
    }
    return counts.due === 0 && this.lastSweepCompletedAt !== null ? 'current' : 'indexing'
  }

  private tick(): Promise<void> {
    return this.loop.queue(
      (signal) => this.pass(signal),
      () => void this.tick()
    )
  }

  private async pass(signal: AbortSignal): Promise<void> {
    this.store.setRetentionCutoffMs(this.cutoffMs())
    const primaryWake = this.primaryWakeNext
    const full = this.sweepNext
    const maintenance = this.maintenanceNext || full
    this.sweepNext = false
    this.maintenanceNext = maintenance
    this.sweepInProgress ||= full
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
        state: this.work,
        roots: this.roots,
        full,
        primaryWake,
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
    }
  }

  private cutoffMs(): number | null {
    return sessionSearchHistoryCutoffMs(this.options.historyDays, this.clock.now())
  }
}
import { resolve } from 'node:path'
