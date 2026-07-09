import type { AgentHookStatusChangeEntry } from './agent-hooks/server'
import type { IdleInstallDecoration, UpdateStatus } from '../shared/types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../shared/agent-status-types'
import { idleInstallDecorationEqual } from './updater-fallback'

/** Sustained-quiet window: all agents must stay idle this long after the
 *  payload is downloaded before the deferred restart fires. Avoids restarting
 *  the instant an agent finishes a turn, right as the user lines up a follow-up. */
export const IDLE_INSTALL_GRACE_MS = 60_000

type IdleInstallControllerDeps = {
  /** Start the download now. Self-guards, so it's safe to call unconditionally. */
  download: () => void
  /** Perform the deferred quit-and-install (mac installer-ready gating included). */
  install: () => void
  /** The updater's current status — the controller reads, never mutates, it. */
  getStatus: () => UpdateStatus
  /** Live agent-status snapshot from the hook server. */
  getActiveAgentSnapshot: () => AgentHookStatusChangeEntry[]
  /** Called when the idle-install decoration changes so the renderer can be
   *  re-broadcast the current status with the new phase / agent count. */
  onDecorationChange: () => void
  now?: () => number
  graceMs?: number
  /** A `working` row older than this is treated as a crashed/abandoned agent and
   *  no longer blocks the install. Defaults to the shared UI freshness window. */
  staleAfterMs?: number
}

/**
 * Owns the "Update when idle" deferral: download immediately, then hold the
 * restart until no agent has been actively `working` for a continuous grace
 * window. Pure of Electron — all side effects arrive through injected deps so
 * the state machine is unit-testable with fake timers.
 *
 * Driven by two event sources, both routed through `evaluate()`:
 *   1. agent-status changes  → `onAgentStatusChange()`
 *   2. updater status changes → `handleUpdaterStatus()`
 */
export class IdleInstallController {
  private armed = false
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private staleCheckTimer: ReturnType<typeof setTimeout> | null = null
  private decoration: IdleInstallDecoration | null = null
  private readonly deps: IdleInstallControllerDeps
  private readonly now: () => number
  private readonly graceMs: number
  private readonly staleAfterMs: number

  constructor(deps: IdleInstallControllerDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.graceMs = deps.graceMs ?? IDLE_INSTALL_GRACE_MS
    this.staleAfterMs = deps.staleAfterMs ?? AGENT_STATUS_STALE_AFTER_MS
  }

  /** Arm the deferred install and kick off the download immediately. */
  arm(): void {
    // Why: idempotent — a double-tap of "Update when idle" must not restart the
    // grace clock or re-trigger the download.
    if (this.armed) {
      return
    }
    this.armed = true
    // Download now so the restart isn't gated on a multi-minute download once
    // agents finally go idle. download() no-ops unless the status can start one.
    this.deps.download()
    this.evaluate()
  }

  /** Disarm: stop waiting and clear the decoration (the download is kept). */
  cancel(): void {
    if (!this.armed) {
      return
    }
    this.armed = false
    this.clearGraceTimer()
    this.clearStaleCheckTimer()
    this.setDecoration(null)
  }

  isArmed(): boolean {
    return this.armed
  }

  getDecoration(): IdleInstallDecoration | null {
    return this.decoration
  }

  onAgentStatusChange(): void {
    if (!this.armed) {
      return
    }
    this.evaluate()
  }

  handleUpdaterStatus(status: UpdateStatus): void {
    if (!this.armed) {
      return
    }
    // A new check cycle (or a no-update result) superseded the armed update;
    // disarm so a later download for a different version isn't silently gated.
    if (status.state === 'idle' || status.state === 'not-available') {
      this.cancel()
      return
    }
    this.evaluate()
  }

  private evaluate(): void {
    if (!this.armed) {
      this.clearGraceTimer()
      this.clearStaleCheckTimer()
      this.setDecoration(null)
      return
    }

    const activeAgents = this.getActiveAgentActivity()
    const activeAgentCount = activeAgents.count
    const downloaded = this.deps.getStatus().state === 'downloaded'

    if (activeAgentCount > 0) {
      // Why: reset, not pause — a new burst of agent activity must restart the
      // quiet window from zero rather than resume a partially-elapsed one.
      this.clearGraceTimer()
      this.setDecoration({
        phase: downloaded ? 'waiting-for-idle' : 'downloading',
        activeAgentCount
      })
      this.scheduleStaleCheck(activeAgents.nextStaleInMs)
      return
    }

    this.clearStaleCheckTimer()
    if (!downloaded) {
      // Idle, but the payload isn't ready yet — wait for the download to finish.
      this.clearGraceTimer()
      this.setDecoration({ phase: 'downloading', activeAgentCount: 0 })
      return
    }

    // Downloaded and idle: start the sustained-quiet grace window, then install.
    this.setDecoration({ phase: 'grace', activeAgentCount: 0 })
    if (!this.graceTimer) {
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null
        this.onGraceElapsed()
      }, this.graceMs)
      this.graceTimer.unref?.()
    }
  }

  private onGraceElapsed(): void {
    if (!this.armed) {
      return
    }
    // Re-check both gates: an agent may have started working, or the download
    // may have been invalidated, during the grace window.
    if (this.getActiveAgentActivity().count > 0 || this.deps.getStatus().state !== 'downloaded') {
      this.evaluate()
      return
    }
    this.armed = false
    this.setDecoration(null)
    this.deps.install()
  }

  private getActiveAgentActivity(): { count: number; nextStaleInMs: number | null } {
    const now = this.now()
    // Why: mirrors AgentAwakeService's wake-eligibility predicate. Only agents
    // observed working in THIS runtime, with a fresh hook event, count — a
    // hydrated row or a long-silent (crashed) agent must not block the restart.
    let count = 0
    let nextStaleInMs: number | null = null
    for (const entry of this.deps.getActiveAgentSnapshot()) {
      if (
        !entry.observedInCurrentRuntime ||
        entry.state !== 'working' ||
        !Number.isFinite(entry.receivedAt)
      ) {
        continue
      }
      const ageMs = now - entry.receivedAt
      if (ageMs > this.staleAfterMs) {
        continue
      }
      count += 1
      const staleInMs = Math.max(0, this.staleAfterMs - ageMs + 1)
      nextStaleInMs = nextStaleInMs === null ? staleInMs : Math.min(nextStaleInMs, staleInMs)
    }
    return { count, nextStaleInMs }
  }

  private setDecoration(next: IdleInstallDecoration | null): void {
    if (idleInstallDecorationEqual(this.decoration, next)) {
      return
    }
    this.decoration = next
    this.deps.onDecorationChange()
  }

  private clearGraceTimer(): void {
    if (!this.graceTimer) {
      return
    }
    clearTimeout(this.graceTimer)
    this.graceTimer = null
  }

  private scheduleStaleCheck(delayMs: number | null): void {
    this.clearStaleCheckTimer()
    if (delayMs === null) {
      return
    }
    // Why: a crashed agent may never emit a final "done" hook; re-evaluate at
    // the freshness boundary so stale working rows cannot block forever.
    this.staleCheckTimer = setTimeout(() => {
      this.staleCheckTimer = null
      this.evaluate()
    }, delayMs)
    this.staleCheckTimer.unref?.()
  }

  private clearStaleCheckTimer(): void {
    if (!this.staleCheckTimer) {
      return
    }
    clearTimeout(this.staleCheckTimer)
    this.staleCheckTimer = null
  }
}
