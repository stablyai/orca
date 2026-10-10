// The one thing that puts an idle agent to rest.
//
// Nothing a viewer does keeps an agent alive or starts one: a chat on screen and a chat in a
// background tab are the same to this sweep. Every few minutes it looks at each open conversation
// and stops the provider child of one that has been quiet for the idle window and owes no work,
// then drops the in-memory fold of one that is only a cache. The conversation itself — its
// record, tab, status row and readers — is untouched, and the next send starts a new child.
//
// Owed work is derived on every tick, never stored, so there is nothing to disagree with it.

import { agentChildWorkLiveness } from '../../../shared/agent-status-child-work-liveness'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export const STRUCTURED_AGENT_SESSION_IDLE_SWEEP_INTERVAL_MS = 5 * 60_000
export const STRUCTURED_AGENT_SESSION_IDLE_MS = 30 * 60_000

export type StructuredAgentSessionIdleSweepDeps = {
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession> & {
    lastActivityAt: (sessionId: string) => number | undefined
    touch: (sessionId: string) => void
  }
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  now: () => number
  isDisposed: () => boolean
  deliveryActive: (sessionId: string) => boolean
  /** The session's child records, the host's one read of them. */
  childWork: (sessionId: string) => readonly AgentChildWorkView[] | undefined
  /** An orchestration dispatch that still owns this session's worker; derived from its database. */
  hasOpenDispatch: (sessionId: string) => boolean
  /** The provider holds a send it took and has not answered; see `holdsDispatch`. */
  providerHoldsDispatch: (sessionId: string) => boolean
  /** Each of these runs inside the session's serialize and never takes it again. */
  stopAgent: (sessionId: string) => Promise<void>
  stopStartingAgent: (sessionId: string) => Promise<void>
  closeConversation: (sessionId: string) => Promise<boolean>
  logger: StructuredAgentSessionLogger
  intervalMs?: number
  idleMs?: number
}

/** The host's reads of what a running child still serves besides its journal. */
export type StructuredAgentSessionChildWorkReads = {
  childWork: () => readonly AgentChildWorkView[] | undefined
  hasOpenDispatch: () => boolean
  providerHoldsDispatch: () => boolean
}

/** Work the running child owes apart from queued sends: a turn, a child agent, an open
 *  orchestration dispatch, a send the provider holds, or a prompt nobody answered. Whatever owes
 *  any of it keeps its child; it builds no snapshot. */
export function structuredAgentSessionChildHasOpenWork(
  journal: Pick<AgentSessionJournal, 'activeTurnId' | 'visitItems'>,
  reads: StructuredAgentSessionChildWorkReads
): boolean {
  if (
    journal.activeTurnId() !== null ||
    agentChildWorkLiveness(reads.childWork()) !== null ||
    reads.hasOpenDispatch() ||
    reads.providerHoldsDispatch()
  ) {
    return true
  }
  let pendingPrompt = false
  journal.visitItems((_itemId, _sequence, body) => {
    // A subagent can raise a prompt the lead turn cannot see.
    pendingPrompt ||=
      (body.kind === 'approval' || body.kind === 'question') && body.resolution.state === 'pending'
  })
  return pendingPrompt
}

export class StructuredAgentSessionIdleSweep {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(private readonly deps: StructuredAgentSessionIdleSweepDeps) {}

  start(): void {
    this.timer = setInterval(
      () => void this.tick(),
      this.deps.intervalMs ?? STRUCTURED_AGENT_SESSION_IDLE_SWEEP_INTERVAL_MS
    )
    // An idle sweep must never be the reason a process stays alive at quit.
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** One pass over every open conversation. Sessions run concurrently, so one waiting behind a
   *  locked start does not hold up the rest; a pass still running skips the next. */
  async tick(): Promise<void> {
    if (this.running || this.deps.isDisposed()) {
      return
    }
    this.running = true
    try {
      await Promise.allSettled(
        [...this.deps.sessions.keys()].map((sessionId) =>
          this.deps
            .serialize(sessionId, () => this.tickUnderSerialize(sessionId))
            .catch((error: unknown) =>
              this.deps.logger.warn('an idle sweep step failed', {
                scope: 'idle-sweep',
                sessionId,
                error
              })
            )
        )
      )
    } finally {
      this.running = false
    }
  }

  /** Re-derives everything inside the session's lock, so an accept already queued ahead is seen. */
  private async tickUnderSerialize(sessionId: string): Promise<void> {
    const session = this.deps.sessions.get(sessionId)
    if (!session || this.deps.isDisposed()) {
      return
    }
    // Owed work is activity, read every tick, so the agent gets a full window once it ends: a child
    // can read done before the lead's wake-up turn writes anything.
    if (session.child && session.child.phase !== 'starting' && this.owesWork(sessionId, session)) {
      this.deps.sessions.touch(sessionId)
      return
    }
    const lastActivityAt = this.deps.sessions.lastActivityAt(sessionId) ?? this.deps.now()
    if (this.deps.now() - lastActivityAt < (this.deps.idleMs ?? STRUCTURED_AGENT_SESSION_IDLE_MS)) {
      return
    }
    if (session.child) {
      // A start that has been quiet this long is not coming: the host stops it, with its reason.
      if (session.child.phase === 'starting') {
        await this.deps.stopStartingAgent(sessionId)
        return
      }
      await this.deps.stopAgent(sessionId)
    }
    await this.deps.closeConversation(sessionId)
  }

  private queuedOrDelivering(sessionId: string, session: StructuredAgentSessionHostSession) {
    return (
      this.deps.deliveryActive(sessionId) ||
      session.journal.submissions().some(isQueuedAgentJournalSubmission)
    )
  }

  /** Work the running child still owes. Scoped to the child: with none, nothing here can pin the
   *  handle, and a leftover prompt or turn row is only history. */
  private owesWork(sessionId: string, session: StructuredAgentSessionHostSession): boolean {
    return (
      this.queuedOrDelivering(sessionId, session) ||
      structuredAgentSessionChildHasOpenWork(session.journal, {
        childWork: () => this.deps.childWork(sessionId),
        hasOpenDispatch: () => this.deps.hasOpenDispatch(sessionId),
        providerHoldsDispatch: () => this.deps.providerHoldsDispatch(sessionId)
      })
    )
  }
}
