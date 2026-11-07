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
import { runSessionSearchPass } from './session-search-pass'
import { sessionSearchHistoryCutoffMs } from './session-search-retention-policy'
import { SessionSearchStore, type SessionSearchStateCounts } from './session-search-store'
import type { SessionSearchDegradedRoot } from './session-search-degraded-roots'
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
  private readonly store: SessionSearchStore
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
    // Claim ownership only after opening succeeds; a failed constructor cannot release a claim.
    this.store = new SessionSearchStore(options.databasePath, onError)
    liveIndexerPaths.add(this.ownershipPath)
    this.store.setRetentionCutoffMs(this.cutoffMs())
    this.unregister = registerSessionSearchIndexConsumer(this.store)
  }

  /** Begin with a full sweep; subsequent ticks reconcile recent files and sweep periodically. */
  start(): Promise<void> {
    if (this.closed || this.started) {
      return this.loop.settled
    }
    this.started = true
    this.sweepNext = true
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
    this.sweepNext ||= options.full === true
    return this.tick()
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

  close(): void {
    if (this.closed) {
      return
    }
    // Preserve final counts for status calls after the store closes.
    this.lastCounts = this.readCounts() ?? this.lastCounts
    this.closed = true
    // Cancel queued and in-flight passes before closing their store.
    this.loop.close()
    this.unregister()
    this.store.close()
    liveIndexerPaths.delete(this.ownershipPath)
  }

  settled(): Promise<void> {
    return this.loop.settled
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
    if (this.left > 0) {
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
    // Refresh the cutoff each pass so purged transcripts cannot immediately be re-indexed.
    this.store.setRetentionCutoffMs(this.cutoffMs())
    const startedAt = this.clock.now()
    const full = this.sweepNext
    // Consume the flag before awaiting so requests arriving during this pass survive.
    this.sweepNext = false
    try {
      if (full && this.options.resolveRoots) {
        const roots = await this.options.resolveRoots(signal)
        if (signal.aborted) {
          return
        }
        this.roots = roots
      }
      const result = await runSessionSearchPass({
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
        // Preserve previous health findings and retry the sweep after an incomplete pass.
        this.sweepNext ||= full
        return
      }
      this.degradedRoots = result.degradedRoots
      this.previousRootsWithFiles = result.rootsWithFiles
      this.lastReconcileAt = this.clock.now()
      this.left = result.left
      // Repeat full discovery while backlogged so reads outside the recency window can progress.
      this.sweepNext ||= result.outOfTime
      if (full) {
        // Deferred reads prevent a sweep from establishing that the index is current.
        if (!result.outOfTime) {
          this.lastSweepCompletedAt = this.lastReconcileAt
        }
        this.cyclesSinceSweep = 0
        return
      }
      this.cyclesSinceSweep += 1
      if (this.cyclesSinceSweep >= this.fullSweepEveryCycles) {
        this.sweepNext = true
      }
    } catch (error) {
      // Retry a failed sweep rather than waiting for the periodic cadence.
      this.sweepNext ||= full
      throw error
    }
  }

  private cutoffMs(): number | null {
    return sessionSearchHistoryCutoffMs(this.options.historyDays, this.clock.now())
  }
}
import { resolve } from 'node:path'
