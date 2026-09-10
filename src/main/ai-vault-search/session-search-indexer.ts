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

/**
 * Database paths a live indexer already owns.
 *
 * One process, one writer, one consumer registration per index. Two indexers on
 * one path both register with the reader, so every transcript is read and
 * written twice and the second write is fenced by the first at random. The
 * recipe for every configuration change is close-then-construct, so the
 * ordering that causes this is the one the recipe already rules out; this is
 * what says so rather than letting it corrupt quietly.
 */
const liveIndexerPaths = new Set<string>()

export type SessionSearchIndexPhase = 'idle' | 'indexing' | 'current' | 'degraded' | 'closed'

export type SessionSearchIndexStatus = {
  phase: SessionSearchIndexPhase
  /** Rows whose content matches the file at the stat the row records. */
  filesIndexed: number
  /** Rows owed a whole read: a declined append, or a window that widened. */
  filesDue: number
  /** Rows whose last read did not commit. */
  filesFailed: number
  degradedRoots: SessionSearchDegradedRoot[]
  lastReconcileAt: number | null
  /** When a whole-machine sweep last finished; null until one has. */
  lastSweepCompletedAt: number | null
}

/**
 * Owns freshness for the index store: a whole-machine sweep, then a timer that
 * keeps the newest N transcripts per agent reconciled and sweeps again every
 * `fullSweepEveryCycles`.
 *
 * A library, not a service. It knows nothing about Electron, the app lifecycle,
 * settings storage, IPC or the panel, and nothing here reads a setting or
 * registers itself anywhere. Whoever constructs it decides all of that.
 *
 * **The store is the only memory.** Every question a pass asks between passes —
 * what is owed a read, what has failed and how often, what the index holds and
 * therefore what may have been deleted, what to report — is answered by a row
 * in the `files` table. There is no queue, no watch set, no hold-out map and no
 * counter with a reset rule. Two things outlive a pass and are not rows: the
 * timer, and one bit per root recording whether the previous pass listed
 * transcripts under it, which is the grace the retirement walk needs and cannot
 * get from the index. That is the whole of it.
 *
 * **Immutable after construction.** There is no `pause`, `resume`, `clear` or
 * `setHistoryDays`. A configuration change is `close()` and a new instance;
 * throwing the index away is
 * `close(); removeSessionSearchDatabase(databasePath);` and a new instance.
 * Widening retention is a new instance whose opening sweep admits the older
 * files; narrowing is the purge that opens every full sweep.
 *
 * The guarantee it makes: while started, a transcript among the newest N per
 * agent that grows, is replaced or is deleted is reflected in the index within
 * one reconcile interval. Everything else is reached by the periodic sweep.
 */
export class SessionSearchIndexer {
  private readonly clock: SessionSearchClock
  private readonly intervalMs: number
  private readonly passDeadlineMs: number
  private readonly recentPerAgent: number
  private readonly fullSweepEveryCycles: number
  private readonly onError: (error: unknown) => void

  private readonly loop: SessionSearchWorkLoop
  private readonly store: SessionSearchStore
  private readonly unregister: () => void
  /** Null until a pass has recorded one; an empty set is a real observation. */
  private previousRootsWithFiles: ReadonlySet<string> | null = null
  private degradedRoots: SessionSearchDegradedRoot[] = []
  private lastReconcileAt: number | null = null
  private lastSweepCompletedAt: number | null = null
  private lastCounts: SessionSearchStateCounts | null = null
  private cyclesSinceSweep = 0
  private sweepNext = false
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
    const onError = options.onError ?? ((error) => console.warn('[ai-vault-search]', error))
    this.onError = onError
    this.loop = new SessionSearchWorkLoop({
      clock: this.clock,
      intervalMs: this.intervalMs,
      onFailure: onError
    })
    if (liveIndexerPaths.has(options.databasePath)) {
      throw new Error(
        `SessionSearchIndexer: ${options.databasePath} already has a live indexer; close it first`
      )
    }
    liveIndexerPaths.add(options.databasePath)
    // Store, registration and indexer share one lifetime, which is what makes
    // the object immutable: there is no second open to get out of step with.
    this.store = new SessionSearchStore(options.databasePath, onError)
    this.store.setRetentionCutoffMs(this.cutoffMs())
    this.unregister = registerSessionSearchIndexConsumer(this.store)
  }

  /** Runs a full sweep, then reconciles on the interval until closed. */
  start(): Promise<void> {
    if (this.closed || this.started) {
      return this.loop.settled
    }
    this.started = true
    this.sweepNext = true
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
    this.sweepNext ||= options.full === true
    return this.tick()
  }

  /**
   * What the index holds, read from the rows rather than tallied.
   *
   * A second connection can compute every number here with one `GROUP BY`,
   * which is the point: nothing is counted as it happens, so nothing can drift
   * from what the database actually holds or need a rule about when to reset.
   */
  status(): SessionSearchIndexStatus {
    // A closed indexer reports what it last knew: opening a shut handle to
    // answer a call whose whole job is to describe what happened is how a close
    // came to report a database error to the owner who asked for it.
    const settled = (this.closed ? this.lastCounts : this.readCounts()) ?? {
      current: 0,
      due: 0,
      failed: 0
    }
    return {
      phase: this.phase(settled),
      filesIndexed: settled.current,
      filesDue: settled.due,
      filesFailed: settled.failed,
      degradedRoots: this.degradedRoots.map((root) => ({ ...root })),
      lastReconcileAt: this.lastReconcileAt,
      lastSweepCompletedAt: this.lastSweepCompletedAt
    }
  }

  /** Stops everything. Nothing queued before this call may run afterwards. */
  close(): void {
    if (this.closed) {
      return
    }
    // Read before the handle goes, so a status call afterwards reports what the
    // index last held rather than opening a database its owner has finished with.
    this.lastCounts = this.readCounts() ?? this.lastCounts
    this.closed = true
    // The loop, not just its timer: a task queued before this call would
    // otherwise still run against a store this line is about to close.
    this.loop.close()
    this.unregister()
    this.store.close()
    liveIndexerPaths.delete(this.options.databasePath)
  }

  /** Tests only: everything else drives this through the timer. */
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

  /**
   * `current` is a claim, so it takes all three: no row owed a read, no row
   * whose last read failed, and a whole sweep that finished. `idle` is the
   * other end of it — an indexer nobody started has not promised to index
   * anything, and calling that `current` would claim an index nobody built is
   * up to date.
   */
  private phase(counts: SessionSearchStateCounts): SessionSearchIndexPhase {
    if (this.closed) {
      return 'closed'
    }
    if (!this.started) {
      return 'idle'
    }
    // A root the pass could not read, or a file it could not read: both are gaps
    // the index knows about and cannot close on its own.
    if (this.degradedRoots.length > 0 || counts.failed > 0) {
      return 'degraded'
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
    // The window moves with the clock, and the decide step reads it from the
    // store. Setting it once at construction leaves a sweep purging rows that
    // the very next candidate check happily re-indexes.
    this.store.setRetentionCutoffMs(this.cutoffMs())
    // The one bound on a pass: wall time. What it does not reach is still owed,
    // because a row says so and nothing had to be written down.
    const startedAt = this.clock.now()
    const full = this.sweepNext
    // Taken on entry, not cleared on the way out: a `reconcile({ full: true })`
    // raised while this pass is running sets it again, and clearing it at the
    // end would erase that request along with this pass's own.
    this.sweepNext = false
    try {
      const result = await runSessionSearchPass({
        store: this.store,
        roots: this.options.roots,
        full,
        recentPerAgent: this.recentPerAgent,
        previousRootsWithFiles: this.previousRootsWithFiles ?? undefined,
        overdue: () => this.clock.now() - startedAt >= this.passDeadlineMs,
        // One readdir per directory for the whole pass, shared by every step.
        listings: new SessionSearchDirectoryListings(),
        signal
      })
      if (!result.completed) {
        // A pass cut short learned nothing about root health, and publishing its
        // empty findings would clear a live alarm. A sweep stays owed.
        this.sweepNext ||= full
        return
      }
      this.degradedRoots = result.degradedRoots
      this.previousRootsWithFiles = result.rootsWithFiles
      this.lastReconcileAt = this.clock.now()
      // A backlog outside the recency window is only visible to a sweep, so a
      // pass that ran out of time asks for one. It is self-limiting: the first
      // pass that finishes its reads hands the interval back to cycles.
      this.sweepNext ||= result.outOfTime
      if (full) {
        this.lastSweepCompletedAt = this.lastReconcileAt
        this.cyclesSinceSweep = 0
        return
      }
      // A root that came back, a tree restored from a backup, an old transcript
      // deleted: only a sweep sees any of it, and the count of cycles is the
      // whole rule for when one is owed.
      this.cyclesSinceSweep += 1
      if (this.cyclesSinceSweep >= this.fullSweepEveryCycles) {
        this.sweepNext = true
      }
    } catch (error) {
      // The flag is this method's to hold, so it is this method's to give back:
      // a pass that threw part way learned nothing, and losing it here would
      // leave nothing armed to try again.
      this.sweepNext ||= full
      throw error
    }
  }

  private cutoffMs(): number | null {
    return sessionSearchHistoryCutoffMs(this.options.historyDays, this.clock.now())
  }
}
