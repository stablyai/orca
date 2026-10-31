import {
  advanceBinderCursor,
  applyBinderOwnerships,
  defaultOpenCodeDbPath,
  listBinderPaneSnapshots,
  OPENCODE_SESSION_CURSOR_START,
  runOpenCodeBinderRound,
  type BinderPaneSnapshot
} from '../../opencode/opencode-session-binder'
import type {
  BinderSessionRow,
  OpenCodeSessionCursor
} from '../../foreign-sqlite-readers/opencode-binder-sessions-result'
import { readOpenCodeBinderSessions } from '../../foreign-sqlite-readers/foreign-sqlite-reader-spawn'
import {
  sweepProcessIdentities,
  type ProcessIdentityRow
} from '../../opencode/opencode-client-sweep'
import { lookupOpenCodeSessionPane } from '../../../shared/agent-hook-listener/opencode-session-registry'
import { AgentHookServerPersistence } from './server-persistence'

const OPENCODE_BINDER_INTERVAL_MS = 60_000
const OPENCODE_BINDER_KICK_DEBOUNCE_MS = 10_000
// Pane inventory can lag session births; retry unbound sessions within this window.
const OPENCODE_BINDER_UNBOUND_RETRY_MS = 10 * 60_000
const OPENCODE_BINDER_PARENTS_MAX = 2_000
const OPENCODE_BINDER_UNBOUND_MAX = 500

export type OpenCodeBinderLoopDeps = {
  now: () => number
  dbPath: () => string
  /** The default reader resolves [] when the store or worker cannot answer. */
  listSessions: (dbPath: string, cursor: OpenCodeSessionCursor) => Promise<BinderSessionRow[]>
  listPanes: () => BinderPaneSnapshot[]
  sweep: () => Promise<ProcessIdentityRow[]>
}

/** Bind shared OpenCode 1 serve sessions to attach panes; remove with OpenCode 1 support (#21359). */
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
    listSessions: (dbPath, cursor) => readOpenCodeBinderSessions(dbPath, cursor),
    listPanes: () => listBinderPaneSnapshots(),
    sweep: () => sweepProcessIdentities()
  }

  /** Keep tests away from the user's database and process table. */
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
    // Bind existing sessions immediately instead of leaving their initial stamp for a full interval.
    void this.runOpenCodeBinderRoundOnce()
  }

  protected stopOpenCodeBinderLoop(): void {
    // Invalidate in-flight rounds so they cannot restore stopped state.
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

  /** Coalesce birth-triggered kicks so new sessions bind before the next poll. */
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
    // An obsolete round's finally must not clear a restarted loop's running flag.
    const generation = this.openCodeBinderGeneration
    try {
      const deps = this.openCodeBinderDeps
      const nowMs = deps.now()
      const fresh = await deps.listSessions(deps.dbPath(), this.openCodeBinderWatermark)
      // Stop resets state and watermark while the worker may still be reading.
      if (generation !== this.openCodeBinderGeneration) {
        return 0
      }
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
      // Untracked rows must remain before the watermark so the next round can retry them.
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
      // Binder failure must not break hook serving; the next round retries.
      console.warn('[opencode-binder] round failed; keeping stamped attribution', err)
      return 0
    } finally {
      if (generation === this.openCodeBinderGeneration) {
        this.openCodeBinderRunning = false
      }
    }
  }
}
