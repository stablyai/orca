// The one thing that starts a provider child for a send, the one thing that hands a message to
// it, and the one thing that settles a queued message because of a start, a child or a leftover.
//
// A send is accepted on its own serialized step and returns; this loop does the rest. It exists
// for a session exactly while a message is queued there — accepted, not yet handed over — and no
// child is running a conversation command: a command's turn takes no input, and the commit that
// ends it wakes the loop again. Every step re-reads the journal and the conversation's child
// record to decide, so there is no loop state to disagree with them. Each step is its own serialized task. That is what lets a Stop
// that arrives while a start holds the queue withdraw the queued messages before the handover that
// would have written them. Stop and the conversation's close are the only other writers of a
// queued message: a child's exit only ends the child, and this loop reads why.

import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import {
  agentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentRegistry } from './structured-agent-registry'
import {
  structuredAgentSessionStartFailure,
  type StructuredAgentSessionStartFailureCause
} from './structured-agent-session-failure-text'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-agent-start'
import type {
  StructuredAgentSessionChildEndCause,
  StructuredAgentSessionEndedChild,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'
import {
  oldestQueuedSubmission,
  recordStructuredAgentSessionStartFailure
} from './structured-agent-session-start-failure-row'
import { failedProviderChildStart } from './structured-agent-session-provider-child'
import { handOverSubmission } from './structured-agent-session-turns'
import { structuredAgentSessionCommandRunning } from './structured-agent-session-command-turn'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

export type StructuredAgentSessionDeliveryLoopDeps = {
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  adapter: StructuredAgentSessionAdapter
  agents: StructuredAgentRegistry
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** A start step, tracked from enqueue so quit waits for the child it may produce. */
  trackStart: <T>(start: Promise<T>) => Promise<T>
  /** Gives the session a provider child if it has none; for a caller inside `serialize`. */
  /** Starts a child for `startedFor`, the queued message at the head, if the session has none. */
  ensureProviderChild: (
    sessionId: string,
    startedFor: string
  ) => Promise<StructuredAgentSessionResumeOutcome>
  /** The fence the conversation's own writes carry; see `structuredAgentSessionConversationFence`. */
  conversationFence: (sessionId: string) => number
  /** Rejects queued messages as a completed close of the chat does; false when that failed. */
  abandonQueued: (
    sessionId: string,
    which: (submission: AgentJournalSubmission) => boolean
  ) => Promise<boolean>
  /** Who the chat's failure sentences name. */
  failureTextContext: (sessionId: string) => AgentSessionFailureWordsContext
  logger: StructuredAgentSessionLogger
  record: (sessionId: string) => AgentSessionRecord | null
  readChildWork: (sessionId: string) => readonly AgentChildWorkView[] | undefined
  now: () => number
}

type Step = 'continue' | 'stop'

type Prepared =
  | 'stop'
  | Extract<StructuredAgentSessionResumeOutcome, { ok: false }>
  | { ok: true; awaited: StructuredAgentSessionProviderChildIdentity | null }

/** A failed start before it is worded; `fail` words it once, through the one wording point. */
type StartFailure = { startKey: string | null; cause: StructuredAgentSessionStartFailureCause }

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
          await this.deps.serialize(sessionId, () =>
            this.fail(sessionId, this.refusedStart(sessionId, prepared))
          )
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
      // The error is Orca's own and goes to the log; the chat says only that Orca failed.
      this.deps.logger.warn('delivering a queued message failed', {
        scope: 'delivery-loop',
        sessionId,
        error
      })
      const cause = { hostFault: true } as const
      await this.deps
        .serialize(sessionId, () => this.fail(sessionId, { startKey: null, cause }))
        .catch((failure: unknown) => {
          // Rows left queued are rejected by the next open, or by the next loop an accept wakes.
          this.running.delete(sessionId)
          this.deps.logger.warn('recording a failed delivery failed', {
            scope: 'delivery-loop-fail',
            sessionId,
            error: failure
          })
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
      agentSessionFailureWords(agentSessionFailureFact('hostRestarted'), { surface: 'rejection' }),
      // A handle closes only with nothing queued, so one an earlier handle wrote is a leftover.
      (submission) => session.journal.wroteBeforeOpen(submission.acceptedSequence)
    )
    if (!(await this.closeWhatTheUserClosed(sessionId, session))) {
      // Never start an agent for a message the user closed; the next wake re-derives and retries.
      return this.stop(sessionId)
    }
    const oldest = oldestQueuedSubmission(session)
    // A running command takes no input while its child carries it; its end is a commit, which
    // wakes the loop again. With no child it is a gone generation's, which the start below settles.
    if (!oldest || (session.child && structuredAgentSessionCommandRunning(session.journal))) {
      return this.stop(sessionId)
    }
    const failedStart = startThatFailedWhileQueued(session, oldest)
    if (failedStart) {
      return this.fail(sessionId, failedStart)
    }
    const ready = await this.deps.ensureProviderChild(sessionId, oldest.clientMessageId)
    if (!ready.ok && ready.refusal.details?.reason === 'previousExitUnverifiable') {
      // Failed in the step that was refused: a message accepted, or an exit proven, after it must
      // not be failed for a verdict that no longer holds.
      return this.fail(sessionId, this.refusedStart(sessionId, ready))
    }
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
    startFailure: SubmissionRejectionFact | null
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
      const endedFailure = ended ? structuredAgentSessionEndedChildFailure(ended) : undefined
      // A user's Stop or close is not a failure: the next step starts, or waits on, a child for
      // what is queued, after closing what a close of the chat closed.
      if (endedFailure === null) {
        return 'continue'
      }
      return this.fail(sessionId, {
        startKey: awaited?.generation ?? null,
        cause: endedFailure ??
          // Gone with no end observed: nothing says the provider stopped.
          { failure: startFailure ?? agentSessionFailureFact('startFailed') }
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
        agents: this.deps.agents,
        providerChildPhase: () => this.deps.sessions.get(sessionId)?.child?.phase,
        failureTextContext: this.deps.failureTextContext(sessionId),
        record: () => this.deps.record(sessionId),
        childWork: () => this.deps.readChildWork(sessionId),
        now: this.deps.now
      },
      next
    )
    return 'continue'
  }

  /** A start the session refused, as the failure every queued message it was for is rejected with. */
  private refusedStart(
    sessionId: string,
    { refusal, diagnostic }: Extract<StructuredAgentSessionResumeOutcome, { ok: false }>
  ): StartFailure {
    // A conversation no agent ever ran, such as a cleared chat's, failed to start, not restart.
    const newSession = this.deps.record(sessionId)?.providerHandleChain.length === 0
    return {
      startKey: null,
      cause: {
        refusal,
        ...(diagnostic ? { diagnostic } : {}),
        ...(newSession ? { newSession: true as const } : {})
      }
    }
  }

  private async fail(sessionId: string, failure: StartFailure): Promise<'stop'> {
    const session = this.deps.sessions.get(sessionId)
    if (session) {
      await recordStructuredAgentSessionStartFailure(
        { journal: session.journal, fence: this.deps.conversationFence(sessionId) },
        {
          startKey: failure.startKey,
          ...structuredAgentSessionStartFailure(
            failure.cause,
            this.deps.failureTextContext(sessionId)
          )
        }
      )
    }
    return this.stop(sessionId)
  }

  /** A close of this chat that stopped its child and then did not complete still closed what was
   *  queued before it, so no child starts for those. Ordered, not latched: a later send goes on.
   *  False when those could not be closed. */
  private async closeWhatTheUserClosed(
    sessionId: string,
    session: StructuredAgentSessionHostSession
  ): Promise<boolean> {
    const ended = session.lastEndedChild
    if (session.child || ended?.cause !== 'user-close') {
      return true
    }
    const { epoch } = session.journal.cursor()
    return this.deps.abandonQueued(
      sessionId,
      (submission) =>
        ended.endedAt.epoch === epoch &&
        submission.acceptedSequence !== undefined &&
        submission.acceptedSequence <= ended.endedAt.sequence
    )
  }

  /** Inside the serialized step that found nothing to do, so an accept after it wakes anew. */
  private stop(sessionId: string): 'stop' {
    this.running.delete(sessionId)
    return 'stop'
  }
}

/** A start that died while this message waited on it — a view's, say — is the message's failed
 *  start: settled with it, under its key, rather than started again into the same failure. */
function startThatFailedWhileQueued(
  session: StructuredAgentSessionHostSession,
  oldest: NonNullable<ReturnType<typeof oldestQueuedSubmission>>
): StartFailure | null {
  const ended = failedProviderChildStart(session)
  if (
    !ended ||
    oldest.acceptedSequence === undefined ||
    ended.endedAt.epoch !== session.journal.cursor().epoch ||
    ended.endedAt.sequence < oldest.acceptedSequence
  ) {
    return null
  }
  const cause = structuredAgentSessionEndedChildFailure(ended)
  return cause ? { startKey: ended.generation, cause } : null
}

function providerEndFailure(
  ended: StructuredAgentSessionEndedChild
): StructuredAgentSessionStartFailureCause {
  if (ended.duringStartup) {
    return { exit: ended.failure }
  }
  return { failure: ended.failure ?? agentSessionFailureFact('providerExited') }
}

// Every end cause, so a new one does not compile until it says whether it fails what is queued.
const ENDED_CHILD_FAILURE = {
  'user-stop': () => null,
  // The user closing this chat closes what was queued before it; see `closeWhatTheUserClosed`.
  'user-close': () => null,
  // The host stopping the child is Orca's cause, never the provider's: a start that never finished.
  'host-stop': () => ({ failure: agentSessionFailureFact('hostStopped') }),
  exit: providerEndFailure,
  // The attach records its own fault as the end's failure.
  'attach-failed': providerEndFailure,
  // Reached only when an eviction's stop landed and a later step failed, leaving the conversation.
  evict: providerEndFailure
} satisfies Record<
  StructuredAgentSessionChildEndCause,
  (ended: StructuredAgentSessionEndedChild) => StructuredAgentSessionStartFailureCause | null
>

/** Why a queued message the child never took is rejected; null when its end fails nothing. */
export function structuredAgentSessionEndedChildFailure(
  ended: StructuredAgentSessionEndedChild
): StructuredAgentSessionStartFailureCause | null {
  return ENDED_CHILD_FAILURE[ended.cause](ended)
}
