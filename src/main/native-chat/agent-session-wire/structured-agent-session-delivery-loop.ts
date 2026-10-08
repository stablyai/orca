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
// queued message: a child's exit only ends the child, and this loop reads why. A message an
// earlier host process left queued is never handed over: the open, or this loop's first step,
// settles it first (`journal-unsent-send-hold.ts`).
//
// A start that fails is recorded on the one message it was for, and the messages behind it each
// get their own start. Every write names a message fixed when its pass chose it, never the queue's
// head read again after a failure.

import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { AgentSessionFailureWordsContext } from '../../../shared/agent-session-failure-words'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentRegistry } from './structured-agent-registry'
import type { StructuredAgentSessionStartFailureCause } from './structured-agent-session-failure-text'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-agent-start'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChildIdentity
} from './structured-agent-session-host-types'
import {
  oldestQueuedSubmission,
  rejectStructuredAgentSessionStartFailure
} from './structured-agent-session-start-failure-settlement'
import {
  childWhoseStartFailed,
  startThatFailedWhileQueued,
  structuredAgentSessionEndedChildFailure
} from './structured-agent-session-ended-child-failure'
import { handOverSubmission } from './structured-agent-session-turns'
import { structuredAgentSessionNextHandover } from './structured-agent-session-opening-send'
import { structuredAgentSessionCommandRunning } from './structured-agent-session-command-turn'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import { holdRestartedStructuredAgentSessionSends } from './structured-agent-session-host-lifetime'

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
  /** Ends the session's child, whose start failed, as a host stop; for a caller inside `serialize`. */
  endFailedStart: (sessionId: string) => Promise<void>
  /** The fence the conversation's own writes carry; see `structuredAgentSessionConversationFence`. */
  conversationFence: (sessionId: string) => number
  /** Settles queued messages as a completed close of the chat does; false when that failed. */
  holdClosed: (
    sessionId: string,
    which: (submission: AgentJournalSubmission) => boolean
  ) => Promise<boolean>
  /** Who the chat's failure sentences name. */
  failureTextContext: (sessionId: string) => AgentSessionFailureWordsContext
  logger: StructuredAgentSessionLogger
  record: (sessionId: string) => AgentSessionRecord | null
  readChildWork: (sessionId: string) => readonly AgentChildWorkView[] | undefined
  /** A person's Stop is still ending the session's work: the status feed's own reading. */
  stopping: (sessionId: string) => boolean
  now: () => number
}

type Step = 'continue' | 'stop'

type RefusedStart = Extract<StructuredAgentSessionResumeOutcome, { ok: false }>

type Prepared =
  | Step
  | (RefusedStart & { startedFor: string })
  // `waitingFor`: the message the start was for.
  | { ok: true; awaited: StructuredAgentSessionProviderChildIdentity | null; waitingFor: string }

/** The message one pass is attempting, set before each await that could fail for it, so a throw
 *  still knows its target. Dies with the pass. */
type Attempt = { clientMessageId?: string }

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
    for (;;) {
      const attempt: Attempt = {}
      let step: Step
      try {
        step = await this.attempt(sessionId, attempt)
      } catch (error) {
        step = await this.failAttempt(sessionId, attempt, error)
      }
      if (step === 'stop') {
        return
      }
    }
  }

  /** One message's pass: a start for it, then its handover. A failed start fails only that
   *  message; the next pass takes the one behind it. */
  private async attempt(sessionId: string, attempt: Attempt): Promise<Step> {
    const prepared = await this.deps.trackStart(
      this.deps.serialize(sessionId, () => this.prepare(sessionId, attempt))
    )
    if (prepared === 'stop' || prepared === 'continue') {
      return prepared
    }
    if (!prepared.ok) {
      if (prepared.aborted) {
        // A close, Stop or quit stopped this start on purpose, and settled what it was for; a
        // message accepted since gets its own start, and quit's next step stops the loop.
        return 'continue'
      }
      return this.deps.serialize(sessionId, () =>
        this.rejectStartFailure(
          sessionId,
          this.refusedStart(sessionId, prepared),
          prepared.startedFor
        )
      )
    }
    return this.deps.serialize(sessionId, () => this.handOver(sessionId, prepared, attempt))
  }

  /** The error is Orca's own and goes to the log; the chat says only that Orca failed, on the
   *  message this pass attempted and never on another. */
  private async failAttempt(sessionId: string, attempt: Attempt, error: unknown): Promise<Step> {
    this.deps.logger.warn('delivering a queued message failed', {
      scope: 'delivery-loop',
      sessionId,
      error
    })
    const { clientMessageId } = attempt
    try {
      return await this.deps.serialize(sessionId, async () =>
        clientMessageId === undefined
          ? this.stop(sessionId)
          : this.rejectStartFailure(sessionId, { hostFault: true }, clientMessageId)
      )
    } catch (failure) {
      // Left queued, it is taken by the next wake, or rejected as a leftover by the next open.
      this.running.delete(sessionId)
      this.deps.logger.warn('recording a failed delivery failed', {
        scope: 'delivery-loop-fail',
        sessionId,
        error: failure
      })
      return 'stop'
    }
  }

  /** Settles what an earlier host process left queued, then makes the session ready. */
  private async prepare(sessionId: string, attempt: Attempt): Promise<Prepared> {
    const session = this.deps.sessions.get(sessionId)
    if (!session || this.disposed) {
      return this.stop(sessionId)
    }
    // The open already did, unless its write failed: a row an earlier handle wrote is never handed
    // over, whether it outlived a quit or a crash. A failure here throws before any message is
    // attempted, so none is handed over: the pass stops, and the next wake or open tries again.
    await holdRestartedStructuredAgentSessionSends(
      this.deps.logger,
      sessionId,
      session.journal,
      this.deps.conversationFence(sessionId)
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
    const failedStart = startThatFailedWhileQueued(session)
    if (failedStart) {
      attempt.clientMessageId = failedStart.clientMessageId
      return this.rejectStartFailure(sessionId, failedStart.cause, failedStart.clientMessageId)
    }
    if (childWhoseStartFailed(session)) {
      // The next message gets a fresh start rather than this child's failure.
      await this.endFailedStart(sessionId)
    }
    attempt.clientMessageId = oldest.clientMessageId
    const ready = await this.deps.ensureProviderChild(sessionId, oldest.clientMessageId)
    if (!ready.ok && ready.refusal.details?.reason === 'previousExitUnverifiable') {
      // Failed in the step that was refused: a message accepted, or an exit proven, after it must
      // not be failed for a verdict that no longer holds.
      return this.rejectStartFailure(
        sessionId,
        this.refusedStart(sessionId, ready),
        oldest.clientMessageId
      )
    }
    if (!ready.ok) {
      return { ...ready, startedFor: oldest.clientMessageId }
    }
    const child = this.deps.sessions.get(sessionId)?.child
    // The child this run waits on; handover checks it is still the one there.
    return {
      ok: true,
      awaited: child ? { generation: child.generation, fence: child.fence } : null,
      waitingFor: oldest.clientMessageId
    }
  }

  private async handOver(
    sessionId: string,
    { awaited, waitingFor }: Extract<Prepared, { ok: true }>,
    attempt: Attempt
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
    // A child still starting takes input: the provider queues it behind its own start.
    if (!awaitedChild) {
      // The child started for this message is gone or replaced by another.
      const ended = awaitedChild ? undefined : session.lastEndedChild
      const endedFailure = ended ? structuredAgentSessionEndedChildFailure(ended) : undefined
      // A user's Stop or close is not a failure: the next step starts, or waits on, a child for
      // what is queued, after closing what a close of the chat closed.
      if (endedFailure === null) {
        return 'continue'
      }
      // A start this message only joined fails the message it was for; this one starts afresh.
      if (ended && ended.startedFor !== waitingFor) {
        return 'continue'
      }
      // A child still here is ended by the next message's step (`childWhoseStartFailed`), after any
      // exit of its own already queued: the message's failure never waits on that cleanup.
      return this.rejectStartFailure(
        sessionId,
        endedFailure ??
          // Gone with no end observed: nothing says the provider stopped.
          { failure: agentSessionFailureFact('startFailed') },
        waitingFor
      )
    }
    // Never steer into a turn a person's Stop is ending: the message runs after it, as its own
    // turn, and the turn's end is a commit that wakes the loop again. Read here, at the handover,
    // because a Stop can take the lane between the step that judged the send and this one.
    if (this.deps.stopping(sessionId)) {
      return this.stop(sessionId)
    }
    // None while a turn is still opening: joining it would record the message ahead of it.
    const next = structuredAgentSessionNextHandover(session, awaitedChild.fence)
    if (!next) {
      return this.stop(sessionId)
    }
    attempt.clientMessageId = next.clientMessageId
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

  /** A start the session refused, as the failure the message it was for is rejected with. */
  private refusedStart(
    sessionId: string,
    { refusal, diagnostic, argumentProblem }: RefusedStart
  ): StructuredAgentSessionStartFailureCause {
    // A conversation no agent ever ran, such as a cleared chat's, failed to start, not restart.
    const newSession = this.deps.record(sessionId)?.providerHandleChain.length === 0
    return {
      refusal,
      ...(diagnostic ? { diagnostic } : {}),
      ...(argumentProblem ? { argumentProblem } : {}),
      ...(newSession ? { newSession: true as const } : {})
    }
  }

  /** Fails only the message the start was for; the next pass takes the one behind it. */
  private async rejectStartFailure(
    sessionId: string,
    cause: StructuredAgentSessionStartFailureCause,
    clientMessageId: string
  ): Promise<'continue'> {
    const session = this.deps.sessions.get(sessionId)
    if (session) {
      await rejectStructuredAgentSessionStartFailure(
        {
          journal: session.journal,
          fence: this.deps.conversationFence(sessionId),
          record: this.deps.record(sessionId)
        },
        cause,
        clientMessageId
      )
    }
    return 'continue'
  }

  /** Ends a child whose start failed, once its message is settled. Best effort: a stop that could
   *  not prove the exit leaves the child closing, and the next start is refused for that
   *  (`previousExitUnverifiable`), as after any such stop. */
  private async endFailedStart(sessionId: string): Promise<void> {
    try {
      await this.deps.endFailedStart(sessionId)
    } catch (error) {
      this.deps.logger.warn('ending a failed start failed', {
        scope: 'delivery-loop-end-failed-start',
        sessionId,
        error
      })
    }
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
    return this.deps.holdClosed(
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
