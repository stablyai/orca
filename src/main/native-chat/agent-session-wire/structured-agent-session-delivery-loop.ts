// The one thing that starts a provider child for a send, and the one thing that hands a message
// to it.
//
// A send is accepted on its own serialized step and returns; this loop does the rest. It exists
// for a session exactly while a message is queued there — accepted, not yet handed over — and
// every step re-reads the journal to decide, so there is no loop state to disagree with it.
// Each step is its own serialized task. That is what lets a Stop that arrives while a start holds
// the queue withdraw the queued messages before the handover that would have written them.

import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import { DISPATCH_REJECTED_HOST_RESTARTED } from '../../../shared/structured-agent-session-dispatch-rejection'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-hold-resume'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import {
  oldestQueuedSubmission,
  recordStructuredAgentSessionStartFailure
} from './structured-agent-session-start-failure-row'
import { handOverSubmission } from './structured-agent-session-turns'

export type StructuredAgentSessionDeliveryLoopDeps = {
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  adapter: StructuredAgentSessionAdapter
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** Gives the session a provider child if it has none; for a caller inside `serialize`. */
  ensureProviderChild: (sessionId: string) => Promise<StructuredAgentSessionResumeOutcome>
  /** The fence the conversation's own writes carry; see `structuredAgentSessionConversationFence`. */
  conversationFence: (sessionId: string) => number
  /** What the chat says when the session could not be made ready. */
  startFailureText: (sessionId: string, cause: AgentSessionWireRefusal) => string
  onError: (sessionId: string, error: unknown) => void
}

type Step = 'continue' | 'stop'

export class StructuredAgentSessionDeliveryLoop {
  private readonly running = new Set<string>()
  private disposed = false

  constructor(private readonly deps: StructuredAgentSessionDeliveryLoopDeps) {}

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  /** Quit: no step after this one starts a child or hands a message over; what is still queued
   *  is left for the next open, which rejects it as never sent. */
  dispose(): void {
    this.disposed = true
  }

  /** From inside the session's serialize, after a message was accepted or the conversation
   *  opened. A loop already running re-reads the journal on its next step. */
  wake(sessionId: string): void {
    if (this.disposed || this.running.has(sessionId)) {
      return
    }
    this.running.add(sessionId)
    void this.run(sessionId)
  }

  private async run(sessionId: string): Promise<void> {
    try {
      for (;;) {
        const ready = await this.deps.serialize(sessionId, () => this.prepare(sessionId))
        if (ready === 'stop') {
          return
        }
        if (!ready.ok) {
          const text = this.deps.startFailureText(sessionId, ready.refusal)
          await this.deps.serialize(sessionId, () => this.fail(sessionId, text))
          return
        }
        // A child published before it proved its start takes no input yet; waited for outside
        // the queue so a Stop can reach it meanwhile.
        await this.deps.adapter.awaitStarted?.(sessionId)
        if ((await this.deps.serialize(sessionId, () => this.handOver(sessionId))) === 'stop') {
          return
        }
      }
    } catch (error) {
      this.deps.onError(sessionId, error)
      const text = this.deps.startFailureText(sessionId, {
        code: 'agent_session_owner_restart_failed',
        message: error instanceof Error ? error.message : String(error)
      })
      await this.deps
        .serialize(sessionId, () => this.fail(sessionId, text))
        .catch((failure: unknown) => {
          // Rows left queued are rejected by the next open, or by the next loop an accept wakes.
          this.running.delete(sessionId)
          this.deps.onError(sessionId, failure)
        })
    }
  }

  /** Settles what an earlier host process left queued, then makes the session ready. */
  private async prepare(sessionId: string): Promise<StructuredAgentSessionResumeOutcome | 'stop'> {
    const session = this.deps.sessions.get(sessionId)
    if (!session || this.disposed) {
      return this.stop(sessionId)
    }
    await session.journal.rejectQueuedSubmissions(
      this.deps.conversationFence(sessionId),
      DISPATCH_REJECTED_HOST_RESTARTED,
      // A handle closes only with nothing queued, so one an earlier handle wrote is a leftover.
      (submission) => session.journal.wroteBeforeOpen(submission.acceptedSequence)
    )
    if (!oldestQueuedSubmission(session)) {
      return this.stop(sessionId)
    }
    return this.deps.ensureProviderChild(sessionId)
  }

  private async handOver(sessionId: string): Promise<Step> {
    const session = this.deps.sessions.get(sessionId)
    if (!session || this.disposed) {
      return this.stop(sessionId)
    }
    // Re-derived here, not carried from the start: the child may have gone since.
    const { child } = session
    if (!child) {
      return 'continue'
    }
    const next = oldestQueuedSubmission(session)
    if (!next) {
      return this.stop(sessionId)
    }
    await handOverSubmission(
      {
        sessionId,
        journal: session.journal,
        fence: child.fence,
        adapter: this.deps.adapter,
        providerChildPhase: () => this.deps.sessions.get(sessionId)?.child?.phase
      },
      next
    )
    return 'continue'
  }

  private async fail(sessionId: string, text: string): Promise<Step> {
    const session = this.deps.sessions.get(sessionId)
    if (session) {
      await recordStructuredAgentSessionStartFailure(
        { journal: session.journal, fence: this.deps.conversationFence(sessionId) },
        text
      )
    }
    return this.stop(sessionId)
  }

  /** Inside the serialized step that found nothing to do, so an accept after it wakes anew. */
  private stop(sessionId: string): 'stop' {
    this.running.delete(sessionId)
    return 'stop'
  }
}
