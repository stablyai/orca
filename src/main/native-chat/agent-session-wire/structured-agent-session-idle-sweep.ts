// The one thing that puts an idle agent to rest.
//
// Nothing a viewer does keeps an agent alive or starts one: a chat on screen and a chat in a
// background tab are the same to this sweep. Every few minutes it looks at each open conversation
// and stops the provider child of one that has been quiet for the idle window and owes no work,
// then drops the open journal handle of one that is only a cache. The conversation itself — its
// record, tab, status row and readers — is untouched, and the next send starts a new child.
//
// Owed work is derived on every tick, never stored, so there is nothing to disagree with it.

import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-projection'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionBackgroundTaskState } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

export const STRUCTURED_AGENT_SESSION_IDLE_SWEEP_INTERVAL_MS = 5 * 60_000
export const STRUCTURED_AGENT_SESSION_IDLE_MS = 30 * 60_000

export type StructuredAgentSessionIdleSweepDeps = {
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession> & {
    lastActivityAt: (sessionId: string) => number | undefined
  }
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  now: () => number
  isDisposed: () => boolean
  deliveryActive: (sessionId: string) => boolean
  backgroundTaskState: (sessionId: string) => AgentSessionBackgroundTaskState | null | undefined
  /** An orchestration dispatch that still owns this session's worker; derived from its database. */
  hasOpenDispatch: (sessionId: string) => boolean
  /** Each of these runs inside the session's serialize and never takes it again. */
  stopAgent: (sessionId: string) => Promise<void>
  stopStartingAgent: (sessionId: string) => Promise<void>
  closeConversation: (sessionId: string) => Promise<boolean>
  onError: (sessionId: string, error: unknown) => void
  intervalMs?: number
  idleMs?: number
}

/** A prompt the user has not answered. A subagent can raise one the lead turn cannot see. */
export function hasPendingStructuredAgentSessionPrompt(
  items: readonly AgentJournalRenderItem[]
): boolean {
  return items.some(
    (item) =>
      (item.body.kind === 'approval' || item.body.kind === 'question') &&
      item.body.resolution.state === 'pending'
  )
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
            .catch((error: unknown) => this.deps.onError(sessionId, error))
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
    // A stop that failed after the child was proven gone: finish it now, before the idle test, so
    // the rows its settlement wrote cannot push the retry out. A message accepted since goes first.
    if (
      session.owesProviderChildWindDown !== undefined &&
      !session.child &&
      !this.queuedOrDelivering(sessionId, session)
    ) {
      await this.deps.stopAgent(sessionId)
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
      if (this.owesWork(sessionId, session)) {
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
    const items = session.journal.snapshot().items
    return (
      activeStructuredAgentSessionTurnId(items) !== null ||
      this.queuedOrDelivering(sessionId, session) ||
      (this.deps.backgroundTaskState(sessionId)?.tasks?.length ?? 0) > 0 ||
      this.deps.hasOpenDispatch(sessionId) ||
      hasPendingStructuredAgentSessionPrompt(items)
    )
  }
}
