import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { StatsSummary } from '../../shared/types'
import type { StatsEvent, StatsAggregates, StatsFile } from './types'

const STATS_SCHEMA_VERSION = 1
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

function getDefaultAggregates(): StatsAggregates {
  return {
    totalAgentsSpawned: 0,
    totalPRsCreated: 0,
    totalAgentTimeMs: 0,
    countedPRs: [],
    firstEventAt: null
  }
}

function getDefaultStatsFile(): StatsFile {
  return {
    schemaVersion: STATS_SCHEMA_VERSION,
    events: [],
    aggregates: getDefaultAggregates()
  }
}

export class StatsCollector {
  private events: StatsEvent[]
  private aggregates: StatsAggregates
  private liveAgents = new Map<string, number>() // ptyId → startTimestamp
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
        const raw = readFileSync(statsFile, 'utf-8')
        const parsed = JSON.parse(raw) as StatsFile
        // Merge with defaults for forward compatibility
        return {
          ...getDefaultStatsFile(),
          ...parsed,
          aggregates: {
            ...getDefaultAggregates(),
            ...parsed.aggregates
          }
        }
      }
    } catch (err) {
      // Why "start fresh" instead of crashing: lifetime aggregates are lost
      // on corruption, which is unfortunate but not critical — this is a
      // "fun stats" feature, not billing data. The corrupt file is left on
      // disk so it can be inspected for debugging.
      console.error('[stats] Failed to load stats, starting fresh:', err)
    }
    return getDefaultStatsFile()
  }

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

  // Serialize the current state and pick a unique temp path. Trimming mutates
  // in-memory state and JSON.stringify must see a consistent snapshot, so both
  // writers call this synchronously before any await to avoid a torn snapshot.
  // The monotonic generation lets a later write veto an earlier, still-in-flight
  // one so a stale rename can never win (see writeToDiskAsync).
  private prepareWritePayload(): {
    statsFile: string
    tmpFile: string
    json: string
    generation: number
  } {
    const statsFile = getStatsFile()

    // Trim events to bounded size before writing
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS)
    }

    const data: StatsFile = {
      schemaVersion: STATS_SCHEMA_VERSION,
      events: this.events,
      aggregates: this.aggregates
    }

    const generation = ++this.writeGeneration
    // Unique temp file so the async debounced writer and the sync shutdown
    // flush never write the same temp path (same pattern as persistence.ts).
    const tmpFile = `${statsFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    return { statsFile, tmpFile, json: JSON.stringify(data), generation }
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
