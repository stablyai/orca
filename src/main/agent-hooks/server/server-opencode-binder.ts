import {
  applyBinderOwnerships,
  defaultOpenCodeDbPath,
  listBinderPaneSnapshots,
  listOpenCodeDbSessions,
  runOpenCodeBinderRound,
  type BinderPaneSnapshot,
  type BinderSessionRow
} from '../../opencode/opencode-session-binder'
import {
  sweepProcessIdentities,
  type ProcessIdentityRow
} from '../../opencode/opencode-client-sweep'
import { lookupOpenCodeSessionPane } from '../../../shared/agent-hook-listener/opencode-session-registry'
import { AgentHookServerPersistence } from './server-persistence'

/** Poll cadence; hook-triggered kicks cover births between polls. */
const OPENCODE_BINDER_INTERVAL_MS = 60_000
const OPENCODE_BINDER_KICK_DEBOUNCE_MS = 10_000
/** Unbound sessions get re-correlated this long (pane inventory may lag births). */
const OPENCODE_BINDER_UNBOUND_RETRY_MS = 10 * 60_000
const OPENCODE_BINDER_PARENTS_MAX = 2_000
const OPENCODE_BINDER_UNBOUND_MAX = 500

export type OpenCodeBinderLoopDeps = {
  now: () => number
  dbPath: () => string
  listSessions: (dbPath: string, sinceMs: number) => BinderSessionRow[]
  listPanes: () => BinderPaneSnapshot[]
  sweep: () => Promise<ProcessIdentityRow[]>
}

/**
 * Session→pane binder loop for the shared OpenCode server (#21359).
 *
 * Sits just above persistence in the chain so ingest layers can kick a round
 * when a birth arrives early, and lifecycle can start/stop the timer. All
 * I/O rides injectable deps (real singletons by default) so tests drive the
 * whole loop without touching the user's opencode.db or process table.
 */
export abstract class AgentHookServerOpenCodeBinder extends AgentHookServerPersistence {
  private openCodeBinderTimer: ReturnType<typeof setInterval> | null = null
  private openCodeBinderKickTimer: ReturnType<typeof setTimeout> | null = null
  private openCodeBinderRunning = false
  private openCodeBinderWatermarkMs = 0
  private openCodeBinderParents = new Map<string, string | null>()
  private openCodeBinderUnbound = new Map<string, { row: BinderSessionRow; firstSeenMs: number }>()
  private openCodeBinderDeps: OpenCodeBinderLoopDeps = {
    now: () => Date.now(),
    dbPath: () => defaultOpenCodeDbPath(),
    listSessions: (dbPath, sinceMs) => listOpenCodeDbSessions(dbPath, sinceMs),
    listPanes: () => listBinderPaneSnapshots(),
    sweep: () => sweepProcessIdentities()
  }

  /** Test seam: drive the loop without the user's database or process table. */
  protected _setOpenCodeBinderDepsForTests(deps: Partial<OpenCodeBinderLoopDeps>): void {
    this.openCodeBinderDeps = { ...this.openCodeBinderDeps, ...deps }
  }

  protected startOpenCodeBinderLoop(): void {
    if (this.openCodeBinderTimer) {
      return
    }
    this.openCodeBinderTimer = setInterval(() => {
      void this.runOpenCodeBinderRoundOnce()
    }, OPENCODE_BINDER_INTERVAL_MS)
    if (this.openCodeBinderTimer.unref) {
      this.openCodeBinderTimer.unref()
    }
  }

  protected stopOpenCodeBinderLoop(): void {
    if (this.openCodeBinderTimer) {
      clearInterval(this.openCodeBinderTimer)
      this.openCodeBinderTimer = null
    }
    if (this.openCodeBinderKickTimer) {
      clearTimeout(this.openCodeBinderKickTimer)
      this.openCodeBinderKickTimer = null
    }
    this.openCodeBinderRunning = false
    this.openCodeBinderWatermarkMs = 0
    this.openCodeBinderParents.clear()
    this.openCodeBinderUnbound.clear()
  }

  /**
   * A birth may have arrived (opencode SessionStart): run one round soon so
   * the session binds before its first busy stretch, instead of waiting out
   * the poll interval. Trailing-edge debounced; concurrent rounds collapse.
   */
  protected kickOpenCodeBinder(): void {
    if (this.openCodeBinderKickTimer) {
      return
    }
    this.openCodeBinderKickTimer = setTimeout(() => {
      this.openCodeBinderKickTimer = null
      void this.runOpenCodeBinderRoundOnce()
    }, OPENCODE_BINDER_KICK_DEBOUNCE_MS)
    if (this.openCodeBinderKickTimer.unref) {
      this.openCodeBinderKickTimer.unref()
    }
  }

  protected async runOpenCodeBinderRoundOnce(): Promise<number> {
    if (this.openCodeBinderRunning) {
      return 0
    }
    this.openCodeBinderRunning = true
    try {
      const deps = this.openCodeBinderDeps
      const nowMs = deps.now()
      const fresh = deps.listSessions(deps.dbPath(), this.openCodeBinderWatermarkMs)
      const sessions = [...fresh]
      for (const [id, entry] of this.openCodeBinderUnbound) {
        if (nowMs - entry.firstSeenMs > OPENCODE_BINDER_UNBOUND_RETRY_MS) {
          this.openCodeBinderUnbound.delete(id)
          continue
        }
        if (!fresh.some((row) => row.id === id)) {
          sessions.push(entry.row)
        }
      }
      if (sessions.length === 0) {
        return 0
      }
      const panes = deps.listPanes()
      const processes = await deps.sweep()
      const knownOwners = new Map<string, string>()
      for (const session of sessions) {
        const bound = lookupOpenCodeSessionPane(this.state, session.id)
        if (bound) {
          knownOwners.set(session.id, bound.paneKey)
        }
        this.openCodeBinderParents.delete(session.id)
        this.openCodeBinderParents.set(session.id, session.parentId)
      }
      while (this.openCodeBinderParents.size > OPENCODE_BINDER_PARENTS_MAX) {
        const oldest = this.openCodeBinderParents.keys().next().value
        if (oldest === undefined) {
          break
        }
        this.openCodeBinderParents.delete(oldest)
      }
      const { ownerships, watermarkMs } = runOpenCodeBinderRound({
        nowMs,
        dbPath: deps.dbPath(),
        sessions,
        panes,
        processes,
        knownOwners,
        parentBySessionId: this.openCodeBinderParents
      })
      const boundIds = new Set(ownerships.map((ownership) => ownership.sessionId))
      const applied = applyBinderOwnerships(this.state, panes, ownerships, nowMs)
      for (const session of sessions) {
        if (knownOwners.has(session.id) || boundIds.has(session.id)) {
          this.openCodeBinderUnbound.delete(session.id)
          continue
        }
        if (!this.openCodeBinderUnbound.has(session.id)) {
          if (this.openCodeBinderUnbound.size >= OPENCODE_BINDER_UNBOUND_MAX) {
            break
          }
          this.openCodeBinderUnbound.set(session.id, { row: session, firstSeenMs: nowMs })
        }
      }
      this.openCodeBinderWatermarkMs = Math.max(this.openCodeBinderWatermarkMs, watermarkMs)
      return applied
    } catch (err) {
      // Why swallow: a binder failure must never break hook serving; the next
      // round retries, and unbound sessions keep today's stamped behavior.
      console.warn('[opencode-binder] round failed; keeping stamped attribution', err)
      return 0
    } finally {
      this.openCodeBinderRunning = false
    }
  }
}
