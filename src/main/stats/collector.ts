import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { StatsSummary } from '../../shared/process-stats-types'
import type { StatsEvent, StatsAggregates } from './types'
import { loadStatsFile, STATS_SCHEMA_VERSION } from './stats-file-loader'
import { AtomicSnapshotWriter } from '../persistence/atomic-snapshot-writer'

const MAX_EVENTS = 10_000
// Bound persistent PR dedup URLs at 2000 (~100KB) across long-lived installs.
const MAX_COUNTED_PRS = 2_000
// Stats are infrequent and UI-insensitive; batch writes more loosely than the main Store.
const DEBOUNCE_MS = 5_000

// Capture after userData overrides and before app naming can change its path.
let _statsFile: string | null = null

/** Use the app environment because plain-Node orcad records stats too (#31112). */
export function initStatsPath(userDataPath = getAppEnvironment().getPath('userData')): string {
  _statsFile = join(userDataPath, 'orca-stats.json')
  return _statsFile
}

function getStatsFile(): string {
  return _statsFile ?? initStatsPath()
}

export class StatsCollector {
  private events: StatsEvent[]
  private aggregates: StatsAggregates
  private liveAgents = new Map<string, number>()
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private readonly snapshotWriter = new AtomicSnapshotWriter(getStatsFile)
  /** Set by flushAsync so the quit flush is the final write; see scheduleSave. */
  private quitFlushStarted = false
  private quitFlushPromise: Promise<void> | null = null
  // Notify star-nag without cyclic imports or coupling the collector to its consumer.
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

  record(event: StatsEvent): void {
    this.events.push(event)
    // A stalled async write must not defer the in-memory retention limit.
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS)
    }
    this.updateAggregates(event)
    this.scheduleSave()
  }

  // Balance lifecycle events per pane session key; unmatched stops must not count.

  onAgentStart(sessionKey: string, at: number, repoId?: string, worktreeId?: string): void {
    this.liveAgents.set(sessionKey, at)
    this.record({
      type: 'agent_start',
      at,
      repoId,
      worktreeId,
      meta: { sessionKey }
    })
  }

  onAgentStop(sessionKey: string, at: number): void {
    const startAt = this.liveAgents.get(sessionKey)
    if (startAt === undefined) {
      return
    }
    this.liveAgents.delete(sessionKey)
    const durationMs = Math.max(0, at - startAt)
    this.aggregates.totalAgentTimeMs += durationMs
    this.record({
      type: 'agent_stop',
      at,
      meta: { sessionKey, durationMs }
    })
  }

  hasCountedPR(prUrl: string): boolean {
    return this.aggregates.countedPRs.includes(prUrl)
  }

  getSummary(): StatsSummary {
    return {
      totalAgentsSpawned: this.aggregates.totalAgentsSpawned,
      totalPRsCreated: this.aggregates.totalPRsCreated,
      totalAgentTimeMs: this.aggregates.totalAgentTimeMs,
      firstEventAt: this.aggregates.firstEventAt
    }
  }

  /** Repeated before-quit passes must remain safe; retain in-memory state so later activity can be flushed again. */
  flush(): void {
    if (this.quitFlushStarted) {
      return
    }
    this.closeOutLiveAgents()
    this.cancelPendingSave()
    this.snapshotWriter.writeSync(() => this.serialize())
  }

  /** Write off-thread so stalled network mounts cannot freeze main. Close agents synchronously before killAllPty skips runtime exit callbacks; never reject the quit barrier. */
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
    const liveSessionKeys = Array.from(this.liveAgents.keys())
    for (const sessionKey of liveSessionKeys) {
      this.onAgentStop(sessionKey, now)
    }
  }

  private updateAggregates(event: StatsEvent): void {
    if (this.aggregates.firstEventAt === null) {
      this.aggregates.firstEventAt = event.at
    }

    switch (event.type) {
      case 'agent_start':
        this.aggregates.totalAgentsSpawned++
        // Notify after increment and isolate listeners so observer failures cannot lose persisted events.
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
          // Trim oldest dedup URLs while preserving the aggregate total; only very old PR lookup coverage is lost.
          if (this.aggregates.countedPRs.length > MAX_COUNTED_PRS) {
            this.aggregates.countedPRs = this.aggregates.countedPRs.slice(-MAX_COUNTED_PRS)
          }
        }
        break
      // onAgentStop already counts duration; do not add it twice.
      case 'agent_stop':
        break
    }
  }

  private scheduleSave(): void {
    // After final quit flush, no unawaited debounce write may race teardown/rename.
    if (this.quitFlushStarted) {
      return
    }
    if (this.writeTimer) {
      return
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      // Write ~900KB snapshots off-thread to avoid main stalls every five seconds.
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
