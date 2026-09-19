import {
  advanceBinderCursor,
  applyBinderOwnerships,
  defaultOpenCodeDbPath,
  listBinderPaneSnapshots,
  listOpenCodeDbSessions,
  OPENCODE_SESSION_CURSOR_START,
  runOpenCodeBinderRound,
  type BinderPaneSnapshot,
  type BinderSessionRow,
  type OpenCodeSessionCursor
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

/** Injectable I/O for the binder loop; real singletons by default, fakes in tests. */
export type OpenCodeBinderLoopDeps = {
  now: () => number
  dbPath: () => string
  listSessions: (dbPath: string, cursor: OpenCodeSessionCursor) => BinderSessionRow[]
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
  private openCodeBinderGeneration = 0
  private openCodeBinderWatermark: OpenCodeSessionCursor = { ...OPENCODE_SESSION_CURSOR_START }
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

  /** Start the 60s poll loop plus one immediate round, idempotently. */
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
    // Why immediately: existing sessions would otherwise keep the frozen
    // stamp for up to a full interval after launch or restart.
    void this.runOpenCodeBinderRoundOnce()
  }

  /** Stop timers and drop ephemeral binder state; in-flight rounds are discarded by generation. */
  protected stopOpenCodeBinderLoop(): void {
    // Why the generation bump: a round awaiting the process sweep must not
    // apply ownerships — or resurrect the watermark — after the loop stopped.
    this.openCodeBinderGeneration += 1
    if (this.openCodeBinderTimer) {
      clearInterval(this.openCodeBinderTimer)
      this.openCodeBinderTimer = null
    }
    if (this.openCodeBinderKickTimer) {
      clearTimeout(this.openCodeBinderKickTimer)
      this.openCodeBinderKickTimer = null
    }
    this.openCodeBinderRunning = false
    this.openCodeBinderWatermark = { ...OPENCODE_SESSION_CURSOR_START }
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

  /** Run one correlate-and-bind round; returns applied binding count. */
  protected async runOpenCodeBinderRoundOnce(): Promise<number> {
    if (this.openCodeBinderRunning) {
      return 0
    }
    this.openCodeBinderRunning = true
    // Why capture before the try: if stop() lands while the sweep is in
    // flight and a restart begins a new round, the obsolete round must not
    // clear the new round's running flag (or two rounds overlap and apply
    // ownership snapshots out of order).
    const generation = this.openCodeBinderGeneration
    try {
      const deps = this.openCodeBinderDeps
      const nowMs = deps.now()
      const fresh = deps.listSessions(deps.dbPath(), this.openCodeBinderWatermark)
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
      if (generation !== this.openCodeBinderGeneration) {
        return 0
      }
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
      const { ownerships } = runOpenCodeBinderRound({
        nowMs,
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
      // Why from handled rows only: a session the full map could not track
      // must stay re-listable next round instead of being silently passed by
      // the watermark.
      this.openCodeBinderWatermark = advanceBinderCursor({
        fresh,
        isHandled: (sessionId) =>
          knownOwners.has(sessionId) ||
          boundIds.has(sessionId) ||
          this.openCodeBinderUnbound.has(sessionId),
        current: this.openCodeBinderWatermark
      })
      return applied
    } catch (err) {
      // Why swallow: a binder failure must never break hook serving; the next
      // round retries, and unbound sessions keep today's stamped behavior.
      console.warn('[opencode-binder] round failed; keeping stamped attribution', err)
      return 0
    } finally {
      if (generation === this.openCodeBinderGeneration) {
        this.openCodeBinderRunning = false
      }
    }
  }
}
