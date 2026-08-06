import { app } from 'electron'
import { join } from 'node:path'
import type { StatsSummary } from '../../shared/types'
import type { StatsEvent, StatsAggregates } from './types'
import { loadStatsFile, STATS_SCHEMA_VERSION } from './stats-file-loader'
import { StatsSnapshotWriter } from './stats-snapshot-writer'

const MAX_EVENTS = 10_000
// Why: countedPRs is a deduplication registry that grows with every PR created
// through Orca. Without a cap, a heavily-used instance accumulates thousands of
// URL strings across months. 2000 entries is about 6-12 months of active use
// for a power user, and at ~50 chars per URL the overhead is ~100KB max.
const MAX_COUNTED_PRS = 2_000
// Why 5s instead of the main store's 300ms: stat events are infrequent
// (a few per session) and not latency-sensitive for the UI.
const DEBOUNCE_MS = 5_000

// Why: same timing constraint as persistence.ts — the path must be captured
// after configureDevUserDataPath() but before app.setName('Orca'). See the
// comment block in persistence.ts:20-28 for the full explanation.
let _statsFile: string | null = null

export function initStatsPath(): void {
  _statsFile = join(app.getPath('userData'), 'orca-stats.json')
}

function getStatsFile(): string {
  if (!_statsFile) {
    // Safety fallback — should not be hit in normal startup.
    _statsFile = join(app.getPath('userData'), 'orca-stats.json')
  }
  return _statsFile
}

export class StatsCollector {
  private events: StatsEvent[]
  private aggregates: StatsAggregates
  private liveAgents = new Map<string, number>() // ptyId → startTimestamp
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private readonly snapshotWriter = new StatsSnapshotWriter(getStatsFile)
  /** Set by flushAsync so the quit flush is the final write; see scheduleSave. */
  private quitFlushStarted = false
  private quitFlushPromise: Promise<void> | null = null
  // Why: star-nag lives in its own service but needs to observe the running
  // agent-spawned counter. A lightweight listener avoids cyclic imports and
  // keeps StatsCollector unaware of how the counter is consumed.
  private agentStartListeners: ((totalAgentsSpawned: number) => void)[] = []

  constructor() {
    const data = loadStatsFile(getStatsFile())
    this.events = data.events
    this.aggregates = data.aggregates
  }

  onAgentStarted(listener: (totalAgentsSpawned: number) => void): () => void {
    this.agentStartListeners.push(listener)
    return () => {
      this.agentStartListeners = this.agentStartListeners.filter((l) => l !== listener)
    }
  }

  getTotalAgentsSpawned(): number {
    return this.aggregates.totalAgentsSpawned
  }

  // ── Recording ──────────────────────────────────────────────────────

  record(event: StatsEvent): void {
    this.events.push(event)
    this.updateAggregates(event)
    this.scheduleSave()
  }

  // ── Agent lifecycle (called by AgentDetector) ─────────────────────

  onAgentStart(ptyId: string, at: number, repoId?: string, worktreeId?: string): void {
    this.liveAgents.set(ptyId, at)
    this.record({
      type: 'agent_start',
      at,
      repoId,
      worktreeId,
      meta: { ptyId }
    })
  }

  onAgentStop(ptyId: string, at: number): void {
    const startAt = this.liveAgents.get(ptyId)
    if (startAt === undefined) {
      return
    }
    this.liveAgents.delete(ptyId)
    const durationMs = Math.max(0, at - startAt)
    this.aggregates.totalAgentTimeMs += durationMs
    this.record({
      type: 'agent_stop',
      at,
      meta: { ptyId, durationMs }
    })
  }

  // ── PR tracking ───────────────────────────────────────────────────

  hasCountedPR(prUrl: string): boolean {
    return this.aggregates.countedPRs.includes(prUrl)
  }

  // ── Query ─────────────────────────────────────────────────────────

  getSummary(): StatsSummary {
    return {
      totalAgentsSpawned: this.aggregates.totalAgentsSpawned,
      totalPRsCreated: this.aggregates.totalPRsCreated,
      totalAgentTimeMs: this.aggregates.totalAgentTimeMs,
      firstEventAt: this.aggregates.firstEventAt
    }
  }

  // ── Shutdown flush ────────────────────────────────────────────────

  /**
   * Idempotent shutdown — closes out live agents and writes to disk.
   *
   * Why idempotent: Electron's before-quit can fire multiple times — the
   * updater handler calls event.preventDefault() to defer macOS installs.
   * We close live agents and write, but do NOT clear in-memory state so
   * a second flush() after resumed activity works correctly.
   */
  flush(): void {
    if (this.quitFlushStarted) {
      return
    }
    this.closeOutLiveAgents()
    this.cancelPendingSave()
    this.snapshotWriter.writeSync(() => this.serialize())
  }

  /**
   * Async twin of flush() for the quit path.
   *
   * Why the quit path needs one: writeToDiskSync parks the Electron main thread for the
   * whole ~900KB write, and on a stalled network profile mount that park is uninterruptible
   * — the app stops repainting and stops responding to Force Quit.
   *
   * Why the agent closeout stays synchronous: will-quit calls this before killAllPty(),
   * which skips runtime.onPtyExit(), so live agents must be stopped before the kill even
   * though the write itself is awaited later.
   *
   * Never throws — it joins the quit teardown barrier, where a rejection is noise.
   */
  flushAsync(): Promise<void> {
    if (this.quitFlushPromise) {
      return this.quitFlushPromise
    }
    this.quitFlushStarted = true
    this.closeOutLiveAgents()
    this.cancelPendingSave()
    this.quitFlushPromise = this.enqueueWrite().catch((err) => {
      console.error('[stats] Failed to flush stats:', err)
    })
    return this.quitFlushPromise
  }

  private closeOutLiveAgents(): void {
    const now = Date.now()
    // Why snapshot keys: onAgentStop mutates liveAgents, so we snapshot
    // the keys first to avoid iterator invalidation.
    const livePtyIds = Array.from(this.liveAgents.keys())
    for (const ptyId of livePtyIds) {
      this.onAgentStop(ptyId, now)
    }
  }

  // ── Persistence ───────────────────────────────────────────────────

  private updateAggregates(event: StatsEvent): void {
    if (this.aggregates.firstEventAt === null) {
      this.aggregates.firstEventAt = event.at
    }

    switch (event.type) {
      case 'agent_start':
        this.aggregates.totalAgentsSpawned++
        // Why: notify listeners synchronously AFTER increment so observers
        // see the post-increment count. Listener errors are swallowed to
        // keep stat recording robust — a buggy listener must not lose the
        // event from the on-disk log.
        for (const listener of this.agentStartListeners) {
          try {
            listener(this.aggregates.totalAgentsSpawned)
          } catch (err) {
            console.error('[stats] agent-start listener threw:', err)
          }
        }
        break
      case 'pr_created':
        this.aggregates.totalPRsCreated++
        if (event.meta?.prUrl) {
          this.aggregates.countedPRs.push(String(event.meta.prUrl))
          // Why: trim oldest entries so the dedup array does not grow without
          // bound. The aggregate totalPRsCreated counter remains accurate; only
          // the dedup lookup for very old PRs is lost, which is acceptable
          // since PRs that old would never be re-counted in practice.
          if (this.aggregates.countedPRs.length > MAX_COUNTED_PRS) {
            this.aggregates.countedPRs = this.aggregates.countedPRs.slice(-MAX_COUNTED_PRS)
          }
        }
        break
      // agent_stop duration is handled directly in onAgentStop() to avoid
      // double-counting — the duration is added to totalAgentTimeMs there.
      case 'agent_stop':
        break
    }
  }

  private scheduleSave(): void {
    // Why: once the quit flush has run, a newly debounced write would fire during teardown
    // with nothing awaiting it, and the process can exit mid-rename.
    if (this.quitFlushStarted) {
      return
    }
    if (this.writeTimer) {
      return // already scheduled
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      // Why async: a chatty session can write ~900KB every 5s and stall the main thread.
      void this.enqueueWrite().catch((err) => {
        console.error('[stats] Failed to write stats:', err)
      })
    }, DEBOUNCE_MS)
  }

  private cancelPendingSave(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
  }

  private serialize(): string {
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS)
    }
    return JSON.stringify({
      schemaVersion: STATS_SCHEMA_VERSION,
      events: this.events,
      aggregates: this.aggregates
    })
  }

  private enqueueWrite(): Promise<void> {
    return this.snapshotWriter.write(() => this.serialize())
  }
}
