// Continue interrupted work only after opt-in; verify prior actions and attribute the instruction to Orca.

import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentSessionRefusalReference,
  type AgentSessionRefusalReference,
  type AgentSessionWireRefusal
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import {
  refusedBy,
  settledVerdict,
  verdictOf,
  type ContinuationSubmission,
  type SubmissionWait
} from './structured-agent-session-continuation-verdict'
import {
  agentSessionSendSubmission,
  type AgentSessionMutationEnvelope,
  type AgentSessionMutationResult,
  type AgentSessionSendResult
} from '../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import { AgentSessionPreDispatchError } from '../operations/structured-agent-session-operation-settlement'
import { continuationEnvelopeOf } from './structured-agent-session-restart-continuation-envelope'
import type { AgentSessionResumeMarker } from '../../../../shared/agent-session/lifecycle/resume/agent-session-resume-marker'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'
import { liftStructuredQueueRestartHold } from '../delivery/structured-agent-session-queued-pause'
import {
  noteNotContinued,
  noteOutcome,
  restartNoteWriter
} from './structured-agent-session-restart-continuation-notes'

/** Envelope acceptance proves only host ownership; preserve provider pending/unknown/rejected outcomes. */
export type StructuredAgentSessionContinuationOutcome = {
  sessionId: string
  outcome: 'continued' | 'pending' | 'unknown' | 'refused'
  reason?: string
  /** Startup refusal; reason then carries its code. */
  refusal?: AgentSessionRefusalReference
}

export type StructuredAgentSessionContinuationHost = {
  sessions: ReadonlyMap<string, { journal: AgentSessionJournal }>
  /** Record fence, even for closed conversations; null means no record. */
  conversationFence: (sessionId: string) => number | null
  send: (input: {
    envelope: AgentSessionMutationEnvelope
    body: AgentJournalMessageItem
    continuation?: true
    beforeRun?: () => void | Promise<void>
  }) => Promise<AgentSessionMutationResult<AgentSessionSendResult>>
  awaitSendSettlement: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<{ value: AgentSessionSendResult } | undefined>
  awaitSendHandedOver: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<{ value: AgentSessionSendResult } | undefined>
  awaitSendDispatched: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<{ value: AgentSessionSendResult } | undefined>
  awaitSendDecided: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<{ value: AgentSessionSendResult } | undefined>
  logger: StructuredAgentSessionLogger
  now: () => number
  /** Recheck under acceptance serialization so the first post-restart message wins. */
  stillResumable: (marker: AgentSessionResumeMarker) => Promise<boolean>
}

/** Bind serialized acceptance checks, settlement waits and attribution notes to the host. */
export function continuationDeps(
  host: Omit<StructuredAgentSessionContinuationHost, 'stillResumable'>,
  stillWanted: () => Promise<boolean>
): StructuredAgentSessionContinuationDeps {
  return {
    currentFence: host.conversationFence,
    send: (input) =>
      host.send({
        ...input,
        continuation: true,
        beforeRun: async () => {
          if (!(await stillWanted())) {
            throw new RestartContinuationSupersededError()
          }
        }
      }),
    awaitSettlement: async (sessionId, clientMessageId) =>
      agentSessionSendSubmission(
        (await host.awaitSendSettlement(sessionId, clientMessageId))?.value
      ),
    awaitHandedOver: async (sessionId, clientMessageId) =>
      agentSessionSendSubmission(
        (await host.awaitSendHandedOver(sessionId, clientMessageId))?.value
      ),
    awaitDispatched: async (sessionId, clientMessageId) =>
      agentSessionSendSubmission(
        (await host.awaitSendDispatched(sessionId, clientMessageId))?.value
      ),
    awaitDecided: async (sessionId, clientMessageId) =>
      agentSessionSendSubmission((await host.awaitSendDecided(sessionId, clientMessageId))?.value),
    logger: host.logger,
    note: restartNoteWriter(host),
    settleUnanswered: async (sessionId, clientMessageId) => {
      const session = host.sessions.get(sessionId)
      const fence = host.conversationFence(sessionId)
      const submission = await session?.journal.reads.submission(clientMessageId)
      // Only a handed-over send: a host-held one is still the host's to deliver.
      if (
        !session ||
        fence === null ||
        submission?.dispatchState !== 'pending' ||
        submission.handedOverAt === undefined
      ) {
        return
      }
      // Unknown is not final: the provider's later accept or reject still applies.
      await session.journal.resolveDispatch({
        clientMessageId,
        state: 'unknown',
        reason: RESTART_CONTINUATION_UNANSWERED,
        fence
      })
    },
    liftRestartHold: async (sessionId) => {
      const session = host.sessions.get(sessionId)
      const fence = host.conversationFence(sessionId)
      if (session && fence !== null) {
        await liftStructuredQueueRestartHold(session.journal, fence)
      }
    }
  }
}

export const RESTART_CONTINUATION_SUPERSEDED = 'agent_session_restart_work_superseded'
export const RESTART_CONTINUATION_UNANSWERED = 'agent_session_restart_continuation_unanswered'

/** Pre-dispatch proof that supersession delivered nothing. */
export class RestartContinuationSupersededError extends AgentSessionPreDispatchError {
  constructor() {
    super(RESTART_CONTINUATION_SUPERSEDED)
    this.name = 'RestartContinuationSupersededError'
  }
}

export type StructuredAgentSessionContinuationDeps = {
  currentFence: (sessionId: string) => number | null
  send: (input: {
    envelope: AgentSessionMutationEnvelope
    body: AgentJournalMessageItem
  }) => Promise<{
    ok: boolean
    refusal?: AgentSessionWireRefusal
    /** Provider verdict is in submission; queued exists only for host return-type compatibility. */
    value?: { submission?: { dispatchState?: string; reason?: string | null }; queued?: unknown }
  }>
  /** Send acceptance may still be pending; await delivery verdict, with undefined proving nothing. */
  awaitSettlement: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<ContinuationSubmission | undefined>
  /** Wait for handover/rejection; undefined means the wait ended without proof. */
  awaitHandedOver: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<ContinuationSubmission | undefined>
  /** Provider's own answer, past a turn that ended without taking the send; undefined proves nothing. */
  awaitDispatched: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<ContinuationSubmission | undefined>
  /** Attribute host continuation/failure; older clients render tone as plain text. */
  note: (sessionId: string, text: string, tone?: 'error' | 'warning') => Promise<void>
  /** Release cards held only by the restart once the continuation has an outcome, so they never wait on it forever. */
  liftRestartHold: (sessionId: string) => Promise<void>
  /** After a give-up, the provider's own accept or reject; undefined when the wait ends without one. */
  awaitDecided?: SubmissionWait
  /** Settle a handed-over continuation its agent never answered, so it stops showing as sending. */
  settleUnanswered?: (sessionId: string, clientMessageId: string) => Promise<void>
  /** Required to report best-effort note failures. */
  logger: StructuredAgentSessionLogger
  /** Answer at acceptance; caller reports pre-acceptance refusal without duplicate retry notes. */
  answerAtAcceptance?: true
}

export type StartedStructuredAgentSessionContinuation =
  | { done: StructuredAgentSessionContinuationOutcome }
  | {
      verdict: () => Promise<StructuredAgentSessionContinuationOutcome>
      /** Settle this chat now as unconfirmed when its agent hasn't answered; no-op once it has. */
      giveUp: () => Promise<void>
    }

/** Return at handover/start failure, or optional acceptance; await provider verdict separately from batch slots. */
export async function startStructuredAgentSessionContinuation(
  deps: StructuredAgentSessionContinuationDeps,
  sessionId: string,
  marker: Pick<AgentSessionResumeMarker, 'activity'>,
  continuationId: string
): Promise<StartedStructuredAgentSessionContinuation> {
  let started: SentContinuation
  try {
    started = await sendContinuation(deps, sessionId, marker, continuationId)
  } catch (error) {
    // Supersession is not failure and needs no chat note.
    if (!(error instanceof RestartContinuationSupersededError) && !deps.answerAtAcceptance) {
      await noteNotContinued(deps, sessionId, 'refused')
    }
    throw error
  }
  if ('done' in started) {
    if (!(deps.answerAtAcceptance && started.done.outcome === 'refused')) {
      await noteOutcome(deps, sessionId, started.done)
    }
    return started
  }
  const { verdict, clientMessageId } = started
  let answered = false
  let gaveUp = false
  return {
    verdict: async () => {
      const outcome = await verdict()
      answered = true
      // After giving up, only a real answer earns a second note.
      if (!gaveUp || outcome.outcome === 'continued' || outcome.outcome === 'refused') {
        await noteOutcome(deps, sessionId, outcome)
      }
      return outcome
    },
    giveUp: async () => {
      if (answered || gaveUp) {
        return
      }
      gaveUp = true
      try {
        await deps.settleUnanswered?.(sessionId, clientMessageId)
      } catch {
        deps.logger.warn('settling an unanswered restart continuation failed', {
          scope: 'restart-continuation-unanswered',
          sessionId
        })
      }
      await noteOutcome(deps, sessionId, { sessionId, outcome: 'unknown' })
      // The agent may still take or refuse it; say so in the chat when it does.
      void deps
        .awaitDecided?.(sessionId, clientMessageId)
        .then(async (decided) => {
          const late = decided && verdictOf(sessionId, decided)
          if (late && (late.outcome === 'continued' || late.outcome === 'refused')) {
            await noteOutcome(deps, sessionId, late)
          }
        })
        .catch(() => {})
    }
  }
}

type SentContinuation =
  | { done: StructuredAgentSessionContinuationOutcome }
  | { verdict: () => Promise<StructuredAgentSessionContinuationOutcome>; clientMessageId: string }

async function sendContinuation(
  deps: StructuredAgentSessionContinuationDeps,
  sessionId: string,
  marker: Pick<AgentSessionResumeMarker, 'activity'>,
  continuationId: string
): Promise<SentContinuation> {
  const fence = deps.currentFence(sessionId)
  if (fence === null) {
    return { done: { sessionId, outcome: 'refused', reason: 'agent_session_not_attached' } }
  }
  const { envelope, body } = await continuationEnvelopeOf(sessionId, fence, marker, continuationId)
  const sent = await deps.send({ envelope, body }).catch((error: unknown) => {
    if (error instanceof AgentSessionPreDispatchError) {
      throw error
    }
    // Persistence can fail after dispatch; a thrown send is not proof of non-delivery.
    deps.logger.warn('sending a restart continuation failed', {
      scope: 'restart-continuation-send',
      sessionId
    })
    return null
  })
  if (!sent) {
    return { done: { sessionId, outcome: 'unknown' } }
  }
  if (!sent.ok) {
    return {
      done: {
        sessionId,
        outcome: 'refused',
        reason: sent.refusal?.code ?? 'agent_session_send_failed',
        ...(sent.refusal ? { refusal: agentSessionRefusalReference(sent.refusal) } : {})
      }
    }
  }
  const clientMessageId = envelope.clientOperationId
  const handOver = () => deps.awaitHandedOver(sessionId, clientMessageId).catch(() => undefined)
  const settle = (handedOver: ContinuationSubmission | undefined) =>
    settledVerdict(deps, sessionId, clientMessageId, handedOver ?? sent.value?.submission)
  if (deps.answerAtAcceptance) {
    // Startup may outlast the client’s wait; verdict notes report later refusal.
    return { verdict: async () => settle(await handOver()), clientMessageId }
  }
  const handedOver = await handOver()
  if (handedOver?.dispatchState === 'rejected') {
    return { done: refusedBy(sessionId, handedOver) }
  }
  return { verdict: () => settle(handedOver), clientMessageId }
}
