// Canonical agent-session boundaries for stats, derived from agent-hook status
// transitions instead of OSC terminal titles. Titles are a display signal: they
// miss hook-only agents entirely and classify any braille-spinner TUI as an
// agent. Hook status is the same truth the sidebar, dashboard, and mobile rows
// read, so stats now agree with what the user sees.

import type { AgentStatusState } from '../../shared/agent-status-types'

/** Structural subset of the agent-hook enriched payload this module needs. */
export type AgentSessionStatusEvent = {
  paneKey: string
  worktreeId?: string
  connectionId: string | null
  /** Identity-only refresh (resume metadata); carries no turn-state transition. */
  providerSessionOnly?: boolean
  /** Relay cache replay rather than a live hook. */
  isReplay?: boolean
  /** Nonterminal state backed only by child state restored from disk. */
  restoredUnconfirmed?: true
  /** When the current state first appeared; preserved across same-state replays. */
  stateStartedAt: number
  payload: { state: AgentStatusState }
}

/** Ordinary pane teardown, or a stamped batch clear for one dropped connection. */
export type AgentSessionClearEvent =
  | { paneKey: string }
  | { transient: true; connectionId: string; clearedAt: number }

/** Where session boundaries land. Matches StatsCollector's lifecycle API. */
export type AgentSessionSink = {
  onAgentStart(sessionKey: string, at: number, repoId?: string, worktreeId?: string): void
  onAgentStop(sessionKey: string, at: number): void
}

export type AgentSessionTransition = 'start' | 'stop' | 'none'

// Why: pane keys are unbounded over a long session (every closed-then-reopened
// pane mints one). Evict oldest so the mirror can't grow without bound; an
// evicted pane costs at most one missed stop boundary, which the quit flush and
// pane-clear paths already cover.
export const AGENT_SESSION_MIRROR_LIMIT = 1000

type MirroredSession = {
  state: AgentStatusState
  connectionId: string | null
  /** True while this recorder has an unmatched onAgentStart out to the sink. */
  open: boolean
}

/**
 * Pure transition classifier — the whole idempotency contract lives here.
 *
 * Rules:
 * - Same state as the mirror is a SNAPSHOT, not a transition. Reconnect replay,
 *   disk hydration, and mid-turn tool-progress events all re-emit the current
 *   state; counting those is what makes every reconnect inflate the totals.
 * - Only a LIVE event may open a session. A replayed or disk-restored `working`
 *   describes work that began in some earlier runtime, so crediting it would
 *   mint a phantom spawn (see #14610: replays carrying an unchanged state used
 *   to re-arm live timing, and cached replays re-fire completion side effects).
 * - Any event may CLOSE a session this recorder opened. A replayed `done` is how
 *   a client learns about a completion it missed while disconnected; refusing it
 *   would strand the session open until the quit flush.
 */
export function classifyAgentSessionTransition(
  previous: Pick<MirroredSession, 'state' | 'open'> | undefined,
  event: AgentSessionStatusEvent
): AgentSessionTransition {
  if (event.providerSessionOnly) {
    return 'none'
  }
  const next = event.payload.state
  if (previous && previous.state === next) {
    return 'none'
  }
  if (next === 'working') {
    const live = event.isReplay !== true && event.restoredUnconfirmed !== true
    return live ? 'start' : 'none'
  }
  return previous?.open ? 'stop' : 'none'
}

/**
 * Mirrors the last hook state per pane and forwards start/stop edges to a sink.
 *
 * The mirror is updated for every accepted event — including replays that do not
 * count — so the next live transition is computed against the truth the hook
 * server holds, not against a gap.
 */
export class AgentSessionTransitionRecorder {
  private sessions = new Map<string, MirroredSession>()

  constructor(private readonly sink: AgentSessionSink) {}

  onStatus(event: AgentSessionStatusEvent): void {
    if (event.providerSessionOnly) {
      return
    }
    const previous = this.sessions.get(event.paneKey)
    const transition = classifyAgentSessionTransition(previous, event)
    if (transition === 'none' && previous?.state === event.payload.state) {
      // Refresh recency without touching session state so a long-running pane
      // isn't evicted ahead of an idle one.
      this.touch(event.paneKey, previous)
      return
    }

    let open = previous?.open ?? false
    if (transition === 'start') {
      this.sink.onAgentStart(event.paneKey, event.stateStartedAt, undefined, event.worktreeId)
      open = true
    } else if (transition === 'stop') {
      this.sink.onAgentStop(event.paneKey, event.stateStartedAt)
      open = false
    }

    this.touch(event.paneKey, {
      state: event.payload.state,
      connectionId: event.connectionId,
      open
    })
    this.evictOldest()
  }

  /** Pane teardown / dropped connection: close what this recorder still holds open. */
  onCleared(clear: AgentSessionClearEvent): void {
    if ('paneKey' in clear) {
      this.closeAndForget(clear.paneKey, Date.now())
      return
    }
    for (const [paneKey, session] of Array.from(this.sessions)) {
      if (session.connectionId === clear.connectionId) {
        this.closeAndForget(paneKey, clear.clearedAt)
      }
    }
  }

  get trackedPaneCount(): number {
    return this.sessions.size
  }

  private closeAndForget(paneKey: string, at: number): void {
    const session = this.sessions.get(paneKey)
    if (!session) {
      return
    }
    if (session.open) {
      this.sink.onAgentStop(paneKey, at)
    }
    this.sessions.delete(paneKey)
  }

  private touch(paneKey: string, session: MirroredSession): void {
    // Delete-then-set keeps Map iteration order least-recently-used first.
    this.sessions.delete(paneKey)
    this.sessions.set(paneKey, session)
  }

  private evictOldest(): void {
    while (this.sessions.size > AGENT_SESSION_MIRROR_LIMIT) {
      const oldest = this.sessions.keys().next()
      if (oldest.done) {
        return
      }
      this.closeAndForget(oldest.value, Date.now())
    }
  }
}
