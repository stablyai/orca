import { app } from 'electron'
import { writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { StatsSummary } from '../../shared/types'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { stringifyJsonWithinByteLimit } from '../../shared/node-bounded-json-stringify'
import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'
import type { StatsEvent, StatsAggregates, StatsFile } from './types'
import { StatsAggregateTracker } from './stats-aggregate-tracker'
import {
  createDefaultStatsFile,
  parseLoadedStatsFile,
  STATS_FILE_MAX_BYTES,
  STATS_LIVE_AGENT_ID_MAX_BYTES,
  STATS_LIVE_AGENT_MAX_ENTRIES,
  STATS_LIVE_AGENT_MAX_RETAINED_ID_BYTES,
  STATS_SCHEMA_VERSION,
  StatsEventLog
} from './stats-retention'

export * from './stats-retention'
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
  private eventLog: StatsEventLog
  private aggregateTracker: StatsAggregateTracker
  private liveAgents = new Map<string, number>() // ptyId → startTimestamp
  private liveAgentIdBytes = 0
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  // Monotonic id stamped on each prepared payload; the highest committed one
  // wins so a slow in-flight async write can't clobber a newer sync flush.
  private writeGeneration = 0
  private lastCommittedGeneration = 0
  // Why: star-nag lives in its own service but needs to observe the running
  // agent-spawned counter. A lightweight listener avoids cyclic imports and
  // keeps StatsCollector unaware of how the counter is consumed.
  private agentStartListeners: ((totalAgentsSpawned: number) => void)[] = []

  constructor() {
    const data = this.load()
    this.eventLog = new StatsEventLog(data.events)
    this.aggregateTracker = new StatsAggregateTracker(data.aggregates)
  }

  private get aggregates(): StatsAggregates {
    return this.aggregateTracker.aggregates
  }

  private get events(): StatsEvent[] {
    return this.eventLog.events
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
    this.eventLog.retain(event)
    this.aggregateTracker.record(event, this.agentStartListeners)
    this.scheduleSave()
  }

  // ── Agent lifecycle (called by AgentDetector) ─────────────────────

  onAgentStart(ptyId: string, at: number, repoId?: string, worktreeId?: string): void {
    const idMeasurement = measureUtf8ByteLength(ptyId, {
      stopAfterBytes: STATS_LIVE_AGENT_ID_MAX_BYTES
    })
    if (!idMeasurement.exceededLimit) {
      if (!this.liveAgents.has(ptyId)) {
        while (
          this.liveAgents.size >= STATS_LIVE_AGENT_MAX_ENTRIES ||
          this.liveAgentIdBytes + idMeasurement.byteLength > STATS_LIVE_AGENT_MAX_RETAINED_ID_BYTES
        ) {
          const oldest = this.liveAgents.entries().next()
          if (oldest.done) {
            break
          }
          const [oldestPtyId, oldestStartAt] = oldest.value
          this.liveAgents.delete(oldestPtyId)
          this.liveAgentIdBytes -= measureUtf8ByteLength(oldestPtyId).byteLength
          this.recordAgentStop(oldestPtyId, oldestStartAt, at)
        }
        this.liveAgentIdBytes += idMeasurement.byteLength
      }
      this.liveAgents.set(ptyId, at)
    }
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
    this.liveAgentIdBytes -= measureUtf8ByteLength(ptyId).byteLength
    this.recordAgentStop(ptyId, startAt, at)
  }

  private recordAgentStop(ptyId: string, startAt: number, at: number): void {
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
    return this.aggregateTracker.getSummary()
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
    const now = Date.now()
    // Why snapshot keys: onAgentStop mutates liveAgents, so we snapshot
    // the keys first to avoid iterator invalidation.
    const livePtyIds = Array.from(this.liveAgents.keys())
    for (const ptyId of livePtyIds) {
      this.onAgentStop(ptyId, now)
    }
    this.cancelPendingSave()
    this.writeToDiskSync()
  }

  // ── Persistence ───────────────────────────────────────────────────

  private load(): StatsFile {
    try {
      const statsFile = getStatsFile()
      if (existsSync(statsFile)) {
        const raw = readNodeFileSyncWithinLimit(statsFile, STATS_FILE_MAX_BYTES).buffer.toString(
          'utf8'
        )
        return parseLoadedStatsFile(raw)
      }
    } catch (err) {
      // Why "start fresh" instead of crashing: lifetime aggregates are lost
      // on corruption, which is unfortunate but not critical — this is a
      // "fun stats" feature, not billing data. The corrupt file is left on
      // disk so it can be inspected for debugging.
      console.error('[stats] Failed to load stats, starting fresh:', err)
    }
    return createDefaultStatsFile()
  }

  private scheduleSave(): void {
    if (this.writeTimer) {
      return // already scheduled
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      // Why: the debounced save is fun-stats telemetry, not crash-critical
      // state, so it uses the async writer to move the ~900KB tmp-file write
      // off the main thread (the stringify stays sync — see prepareWritePayload).
      // A chatty multi-agent session re-arms this every 5s; a fully-sync write
      // is a recurring main-thread stall. Shutdown flush() stays synchronous;
      // the generation guard keeps the two paths race-safe.
      void this.writeToDiskAsync().catch((err) => {
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

  // Serialize the current state and pick a unique temp path. JSON.stringify
  // must see a consistent snapshot, so both writers call this synchronously
  // before any await to avoid a torn snapshot.
  // The monotonic generation lets a later write veto an earlier, still-in-flight
  // one so a stale rename can never win (see writeToDiskAsync).
  private prepareWritePayload(): {
    statsFile: string
    tmpFile: string
    json: string
    generation: number
  } {
    const statsFile = getStatsFile()

    const data: StatsFile = {
      schemaVersion: STATS_SCHEMA_VERSION,
      events: this.events,
      aggregates: this.aggregates
    }

    const generation = ++this.writeGeneration
    // Unique temp file so the async debounced writer and the sync shutdown
    // flush never write the same temp path (same pattern as persistence.ts).
    const tmpFile = `${statsFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    const json = stringifyJsonWithinByteLimit(data, STATS_FILE_MAX_BYTES).serialized
    return { statsFile, tmpFile, json, generation }
  }

  private writeToDiskSync(): void {
    const dir = dirname(getStatsFile())
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const { statsFile, tmpFile, json, generation } = this.prepareWritePayload()
    writeFileSync(tmpFile, json, 'utf-8')
    renameSync(tmpFile, statsFile)
    this.lastCommittedGeneration = Math.max(this.lastCommittedGeneration, generation)
  }

  private async writeToDiskAsync(): Promise<void> {
    const dir = dirname(getStatsFile())
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }
    const { statsFile, tmpFile, json, generation } = this.prepareWritePayload()
    // Only the ~900KB tmp write moves off the main thread; stringify stayed sync
    // above (torn-snapshot constraint). The rename is a trivial metadata op done
    // SYNCHRONOUSLY so it stays ordered with the shutdown flush's renameSync —
    // an async rename could land after flush and clobber the more-complete
    // shutdown data. The generation guard vetoes this write if a newer one (a
    // later debounce OR the shutdown flush) already committed while we were
    // writing; the check + rename run with no await between them, so the sync
    // flush cannot interleave.
    await writeFile(tmpFile, json, 'utf-8')
    if (this.lastCommittedGeneration >= generation) {
      await rm(tmpFile, { force: true }).catch(() => {})
      return
    }
    renameSync(tmpFile, statsFile)
    this.lastCommittedGeneration = generation
  }
}
