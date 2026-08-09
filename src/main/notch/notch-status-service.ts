// Owns the notch's view of agent status, in main, independent of any window.
//
// Why main and not a renderer relay: agentStatus:set/:clear are targeted at the main window's
// webContents and detached when it closes, so a second window subscribing through window.api
// would go permanently silent. subscribeEnrichedStatus/subscribePaneStatusClear are additive and
// survive, which is the whole point of a status surface you can see with the app closed.
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  EMPTY_NOTCH_SUMMARY,
  buildNotchSummary,
  type NotchStatusSummary
} from '../../shared/notch/notch-status-summary'

export type NotchStatusSource = {
  getStatusSnapshot(): AgentStatusIpcPayload[]
  subscribeEnrichedStatus(listener: (payload: unknown) => void): () => void
  subscribePaneStatusClear(listener: (clear: unknown) => void): () => void
}

export type NotchStatusServiceOptions = {
  source: NotchStatusSource
  /** Coalesces bursts; a hook storm across worktrees must not repaint per event. */
  scheduleFlush?: (flush: () => void) => () => void
  /**
   * Re-evaluates staleness with no new events.
   * Why: an agent killed mid-turn sends no further hook, so only the passing of time can
   * retire its row. Without this the bar would hold a phantom count until something unrelated
   * happened to fire.
   */
  startStaleTicker?: (tick: () => void) => () => void
}

const DEFAULT_FLUSH_DELAY_MS = 80
const DEFAULT_STALE_TICK_MS = 60_000

function defaultScheduleFlush(flush: () => void): () => void {
  const timer = setTimeout(flush, DEFAULT_FLUSH_DELAY_MS)
  return () => clearTimeout(timer)
}

function defaultStaleTicker(tick: () => void): () => void {
  const timer = setInterval(tick, DEFAULT_STALE_TICK_MS)
  // Why: a minute-resolution sweep must never be the reason the process stays alive.
  timer.unref?.()
  return () => clearInterval(timer)
}

export class NotchStatusService {
  private readonly source: NotchStatusSource
  private readonly scheduleFlush: (flush: () => void) => () => void
  private readonly startStaleTicker: (tick: () => void) => () => void
  private stopStaleTicker: (() => void) | null = null
  private readonly listeners = new Set<(summary: NotchStatusSummary) => void>()
  private readonly unsubscribes: (() => void)[] = []
  private acknowledgedAtByPaneKey: Record<string, number> = {}
  private summary: NotchStatusSummary = EMPTY_NOTCH_SUMMARY
  private cancelPendingFlush: (() => void) | null = null
  private flushPending = false
  private started = false

  constructor(options: NotchStatusServiceOptions) {
    this.source = options.source
    this.scheduleFlush = options.scheduleFlush ?? defaultScheduleFlush
    this.startStaleTicker = options.startStaleTicker ?? defaultStaleTicker
  }

  start(): void {
    if (this.started) {
      return
    }
    this.started = true
    // Why: a clear is only a trigger — the recompute below re-reads the snapshot, so a removal
    // and an update can never disagree about what the bar shows.
    this.unsubscribes.push(
      this.source.subscribeEnrichedStatus(() => this.requestRecompute()),
      this.source.subscribePaneStatusClear(() => this.requestRecompute())
    )
    this.stopStaleTicker = this.startStaleTicker(() => this.recompute())
    this.recompute()
  }

  stop(): void {
    this.cancelPendingFlush?.()
    this.cancelPendingFlush = null
    this.flushPending = false
    this.stopStaleTicker?.()
    this.stopStaleTicker = null
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      unsubscribe()
    }
    this.listeners.clear()
    this.started = false
  }

  getSummary(): NotchStatusSummary {
    return this.summary
  }

  subscribe(listener: (summary: NotchStatusSummary) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Mirrors the renderer's acknowledgeAgents so a finished agent stops counting green once its
   * pane is visited. No acks arrive while the main window is closed, which is correct — nothing
   * is being viewed then.
   */
  acknowledgePanes(paneKeys: readonly string[], acknowledgedAt: number): void {
    let changed = false
    for (const paneKey of paneKeys) {
      if ((this.acknowledgedAtByPaneKey[paneKey] ?? 0) < acknowledgedAt) {
        this.acknowledgedAtByPaneKey[paneKey] = acknowledgedAt
        changed = true
      }
    }
    if (changed) {
      this.recompute()
    }
  }

  // Why: the guard tracks a boolean rather than the cancel handle — a synchronous scheduler
  // runs the callback before scheduleFlush returns, so the handle would be assigned after the
  // callback cleared it and latch the throttle on forever.
  private requestRecompute(): void {
    if (this.flushPending) {
      return
    }
    this.flushPending = true
    this.cancelPendingFlush = this.scheduleFlush(() => {
      this.flushPending = false
      this.cancelPendingFlush = null
      this.recompute()
    })
  }

  private recompute(): void {
    const snapshot = this.source.getStatusSnapshot()
    this.pruneAcknowledgements(snapshot)
    const next = buildNotchSummary({
      snapshot,
      acknowledgedAtByPaneKey: this.acknowledgedAtByPaneKey
    })
    if (summariesEqual(this.summary, next)) {
      return
    }
    this.summary = next
    for (const listener of this.listeners) {
      try {
        listener(next)
      } catch (err) {
        console.error('[notch] summary listener threw', err)
      }
    }
  }

  // Why: pane keys are reused after teardown, so a stale ack would suppress a later agent's
  // green the moment it finished.
  private pruneAcknowledgements(snapshot: readonly AgentStatusIpcPayload[]): void {
    const live = new Set(snapshot.map((entry) => entry.paneKey))
    for (const paneKey of Object.keys(this.acknowledgedAtByPaneKey)) {
      if (!live.has(paneKey)) {
        delete this.acknowledgedAtByPaneKey[paneKey]
      }
    }
  }
}

function summariesEqual(a: NotchStatusSummary, b: NotchStatusSummary): boolean {
  if (
    a.counts.working !== b.counts.working ||
    a.counts.attention !== b.counts.attention ||
    a.counts.done !== b.counts.done ||
    a.sessions.length !== b.sessions.length
  ) {
    return false
  }
  return a.sessions.every((session, index) => {
    const other = b.sessions[index]
    return (
      session.paneKey === other.paneKey &&
      session.lane === other.lane &&
      session.state === other.state &&
      session.stateStartedAt === other.stateStartedAt &&
      // Why: these feed a row's label and its click target. Comparing only lane/state let an
      // identity-only change (pane re-attributed to another worktree or tab) skip publishing,
      // leaving a row whose click routed to the pane it used to point at.
      session.worktreeId === other.worktreeId &&
      session.tabId === other.tabId &&
      session.agentType === other.agentType &&
      session.connectionId === other.connectionId
    )
  })
}
