// Hook transitions align desktop/dashboard/mobile stats; OSC titles miss hook-only agents and can mistake spinner TUIs for execution.

import { isAgentTimeAccruing } from '../../shared/agent-lead-status-fold'
import type { AgentStatusPayload } from '../../shared/agent-status-types'

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
  /** When the current combined state first appeared; preserved across same-state replays. */
  stateStartedAt: number
  /** When this event arrived; a replay restamps it. */
  receivedAt: number
  /** When this evidence was first observed; survives a replay. Absent means `receivedAt`. */
  evidenceObservedAt?: number
  /** The combined row state and its watch-loop mode: a settled main agent's background shell holds
   *  the row `working`, and the stats must not count it. */
  payload: Pick<AgentStatusPayload, 'state' | 'workingMode'>
}

/** Ordinary pane teardown, or a stamped batch clear for one dropped connection. */
export type AgentSessionClearEvent =
  | { paneKey: string }
  | { transient: true; connectionId: string; clearedAt: number }

export type AgentSessionSink = {
  onAgentStart(sessionKey: string, at: number, repoId?: string, worktreeId?: string): void
  onAgentStop(sessionKey: string, at: number): void
}

export type AgentSessionTransition = 'start' | 'stop' | 'none'

// Bound long-session pane churn; quit flush/clear paths cover any evicted unmatched stop.
export const AGENT_SESSION_MIRROR_LIMIT = 1000

type MirroredSession = {
  /** Whether the row last said an agent was executing (the main agent or live agent child work). */
  executing: boolean
  connectionId: string | null
  /** True while this recorder has an unmatched onAgentStart out to the sink. */
  open: boolean
}

/** Snapshots never count transitions. Only live evidence may open a session; any event may close one we opened, including completions missed while disconnected (#14610). Restored main-agent facts are historical too. */
export function classifyAgentSessionTransition(
  previous: Pick<MirroredSession, 'executing' | 'open'> | undefined,
  event: AgentSessionStatusEvent
): AgentSessionTransition {
  if (event.providerSessionOnly) {
    return 'none'
  }
  const executing = isAgentTimeAccruing(event.payload)
  if (previous && previous.executing === executing) {
    return 'none'
  }
  if (executing) {
    const live = event.isReplay !== true && event.restoredUnconfirmed !== true
    return live ? 'start' : 'none'
  }
  return previous?.open ? 'stop' : 'none'
}

/** Use this host's clocks: leaving working uses row state time; edges within working and first live rows after hydration use evidence time to exclude monitoring/history gaps. */
export function agentExecutionEdgeAt(event: AgentSessionStatusEvent): number {
  return event.payload.state === 'working'
    ? (event.evidenceObservedAt ?? event.receivedAt)
    : event.stateStartedAt
}

/** Mirror all accepted events, including non-counting replays, so live transitions compare against current hook truth. */
export class AgentSessionTransitionRecorder {
  private sessions = new Map<string, MirroredSession>()

  constructor(private readonly sink: AgentSessionSink) {}

  onStatus(event: AgentSessionStatusEvent): void {
    if (event.providerSessionOnly) {
      return
    }
    const previous = this.sessions.get(event.paneKey)
    const transition = classifyAgentSessionTransition(previous, event)
    const executing = isAgentTimeAccruing(event.payload)
    if (transition === 'none' && previous?.executing === executing) {
      // Refresh recency without changing state so long-running panes are not evicted ahead of idle ones.
      this.touch(event.paneKey, previous)
      return
    }

    let open = previous?.open ?? false
    if (transition === 'start') {
      this.sink.onAgentStart(
        event.paneKey,
        agentExecutionEdgeAt(event),
        undefined,
        event.worktreeId
      )
      open = true
    } else if (transition === 'stop') {
      this.sink.onAgentStop(event.paneKey, agentExecutionEdgeAt(event))
      open = false
    }

    this.touch(event.paneKey, {
      executing,
      connectionId: event.connectionId,
      open
    })
    this.evictOldest()
  }

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
