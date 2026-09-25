// The one thing that starts a provider child for a send, the one thing that hands a message to
// it, and the one thing that settles a queued message because of a start, a child or a leftover.
//
// A send is accepted on its own serialized step and returns; this loop does the rest. It exists
// for a session exactly while a message is queued there — accepted, not yet handed over — and
// every step re-reads the journal and the conversation's child record to decide, so there is no
// loop state to disagree with them. Each step is its own serialized task. That is what lets a Stop
// that arrives while a start holds the queue withdraw the queued messages before the handover that
// would have written them. Stop and the conversation's close are the only other writers of a
// queued message: a child's exit only ends the child, and this loop reads why.

import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import { DISPATCH_REJECTED_HOST_RESTARTED } from '../../../shared/structured-agent-session-dispatch-rejection'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  providerExitBeforeDeliveryRejection,
  providerStartupFailureOutcome
} from './structured-agent-session-dead-generation-settlement'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-agent-start'
import type {
  StructuredAgentSessionEndedChild,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'
import {
  oldestQueuedSubmission,
  recordStructuredAgentSessionStartFailure
} from './structured-agent-session-start-failure-row'
import { handOverSubmission } from './structured-agent-session-turns'

export type StructuredAgentSessionDeliveryLoopDeps = {
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  adapter: StructuredAgentSessionAdapter
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** A start step, tracked from enqueue so quit waits for the child it may produce. */
  trackStart: <T>(start: Promise<T>) => Promise<T>
  /** Gives the session a provider child if it has none; for a caller inside `serialize`. */
  ensureProviderChild: (sessionId: string) => Promise<StructuredAgentSessionResumeOutcome>
  /** The fence the conversation's own writes carry; see `structuredAgentSessionConversationFence`. */
  conversationFence: (sessionId: string) => number
  /** What the chat says when the session could not be made ready. */
  startFailureText: (sessionId: string, cause: AgentSessionWireRefusal) => string
  onError: (sessionId: string, error: unknown) => void
}

type Step = 'continue' | 'stop'

type Prepared =
  | 'stop'
  | { ok: false; refusal: AgentSessionWireRefusal }
  | { ok: true; awaited: StructuredAgentSessionProviderChildIdentity | null }

type StartFailure = { startKey: string | null; text: string }

export class StructuredAgentSessionDeliveryLoop {
  private readonly running = new Set<string>()
  private disposed = false

  constructor(private readonly deps: StructuredAgentSessionDeliveryLoopDeps) {}

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  /** Quit: no step after this one starts a child or hands a message over. */
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
        const prepared = await this.deps.trackStart(
          this.deps.serialize(sessionId, () => this.prepare(sessionId))
        )
        if (prepared === 'stop') {
          return
        }
        if (!prepared.ok) {
          const text = this.deps.startFailureText(sessionId, prepared.refusal)
          await this.deps.serialize(sessionId, () => this.fail(sessionId, { startKey: null, text }))
          return
        }
        // A child published before it proved its start takes no input yet; waited for outside
        // the queue so a Stop can reach it meanwhile.
        const failure = await this.deps.adapter.awaitStarted?.(sessionId)
        const handed = await this.deps.serialize(sessionId, () =>
          this.handOver(sessionId, prepared.awaited, failure || null)
        )
        if (handed === 'stop') {
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
        .serialize(sessionId, () => this.fail(sessionId, { startKey: null, text }))
        .catch((failure: unknown) => {
          // Rows left queued are rejected by the next open, or by the next loop an accept wakes.
          this.running.delete(sessionId)
          this.deps.onError(sessionId, failure)
        })
    }
  }

  /** Settles what an earlier host process left queued, then makes the session ready. */
  private async prepare(sessionId: string): Promise<Prepared> {
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
    const ready = await this.deps.ensureProviderChild(sessionId)
    if (!ready.ok) {
      return ready
    }
    const child = this.deps.sessions.get(sessionId)?.child
    // The child this run waits on; handover checks it is still the one there.
    return {
      ok: true,
      awaited: child ? { generation: child.generation, fence: child.fence } : null
    }
  }

  private async handOver(
    sessionId: string,
    awaited: StructuredAgentSessionProviderChildIdentity | null,
    startFailure: string | null
  ): Promise<Step> {
    const session = this.deps.sessions.get(sessionId)
    if (!session || this.disposed) {
      return this.stop(sessionId)
    }
    // Re-derived here, not carried from the start: the child may have ended, or another may have
    // taken its place, since.
    const { child } = session
    const awaitedChild =
      child && awaited && child.generation === awaited.generation && child.fence === awaited.fence
        ? child
        : null
    // The host's `starting` trails the adapter's `started` by one serialized step, so for the child
    // waited on, the adapter's own answer decides whether its start landed.
    if (!awaitedChild || (awaitedChild.phase === 'starting' && startFailure !== null)) {
      // The child waited on is gone, replaced by another, or settled its start without proving it.
      const ended = awaitedChild ? undefined : session.lastEndedChild
      // A user's Stop is not a failure: the next step starts, or waits on, a child for what is
      // queued. A host stop is: its cause is why the start did not land.
      if (ended?.cause === 'user-stop') {
        return 'continue'
      }
      return this.fail(sessionId, {
        startKey: awaited?.generation ?? null,
        text: ended ? endedChildRejection(ended) : (startFailure ?? providerStartupFailureOutcome())
      })
    }
    const next = oldestQueuedSubmission(session)
    if (!next) {
      return this.stop(sessionId)
    }
    await handOverSubmission(
      {
        sessionId,
        journal: session.journal,
        fence: awaitedChild.fence,
        adapter: this.deps.adapter,
        providerChildPhase: () => this.deps.sessions.get(sessionId)?.child?.phase
      },
      next
    )
    return 'continue'
  }

  private async fail(sessionId: string, failure: StartFailure): Promise<Step> {
    const session = this.deps.sessions.get(sessionId)
    if (session) {
      await recordStructuredAgentSessionStartFailure(
        { journal: session.journal, fence: this.deps.conversationFence(sessionId) },
        failure
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

const HOST_STOPPED_BEFORE_DELIVERY = 'Orca stopped the agent before this message was sent.'

/** Why a queued message the child never took is rejected, in the words the chat row uses. */
function endedChildRejection(ended: StructuredAgentSessionEndedChild): string {
  if (ended.cause === 'host-stop') {
    return ended.reason ?? HOST_STOPPED_BEFORE_DELIVERY
  }
  const reason = ended.reason ?? undefined
  return ended.duringStartup
    ? providerStartupFailureOutcome(reason)
    : providerExitBeforeDeliveryRejection(reason)
}
