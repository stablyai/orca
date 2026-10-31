// Continue interrupted work only after opt-in; verify prior actions and attribute the instruction to Orca.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import {
  agentSessionRefusalReference,
  type AgentSessionRefusalReference
} from '../../../shared/agent-session-wire-refusals'
import {
  refusedBy,
  verdictOf,
  type ContinuationSubmission
} from './structured-agent-session-continuation-verdict'
import {
  agentSessionSendSubmission,
  type AgentSessionMutationEnvelope,
  type AgentSessionMutationResult,
  type AgentSessionSendResult,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { RESTART_CONTINUATION_ROW_PREFIX } from '../../../shared/agent-session-stop-row-identity'
import {
  AGENT_SESSION_RESTART_CONTINUATION_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE,
  AGENT_SESSION_RESTART_NOT_CONNECTED_NOTE
} from '../../../shared/agent-session-restart-continuation'
import { AgentSessionPreDispatchError } from './structured-agent-session-operation-settlement'
import { restartContinuationEnvelope } from './structured-agent-session-restart-continuation-envelope'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

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
    beforeRun?: () => void
  }) => Promise<AgentSessionMutationResult<AgentSessionSendResult>>
  awaitSendSettlement: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<{ value: AgentSessionSendResult } | undefined>
  awaitSendHandedOver: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<{ value: AgentSessionSendResult } | undefined>
  logger: StructuredAgentSessionLogger
  now: () => number
  /** Recheck under acceptance serialization so the first post-restart message wins. */
  stillResumable: (marker: AgentSessionResumeMarker) => boolean
}

/** Bind serialized acceptance checks, settlement waits and attribution notes to the host. */
export function continuationDeps(
  host: Omit<StructuredAgentSessionContinuationHost, 'stillResumable'>,
  stillWanted: () => boolean
): StructuredAgentSessionContinuationDeps {
  return {
    currentFence: host.conversationFence,
    send: (input) =>
      host.send({
        ...input,
        beforeRun: () => {
          if (!stillWanted()) {
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
    logger: host.logger,
    note: restartNoteWriter(host)
  }
}

function restartNoteWriter(
  host: Pick<StructuredAgentSessionContinuationHost, 'sessions' | 'conversationFence' | 'now'>
): StructuredAgentSessionContinuationDeps['note'] {
  return async (sessionId, text, tone) => {
    const session = host.sessions.get(sessionId)
    const fence = host.conversationFence(sessionId)
    if (!session || fence === null) {
      return
    }
    await session.journal.appendItem(
      {
        provider: 'orca',
        clientMessageId: `${RESTART_CONTINUATION_ROW_PREFIX}${sessionId}:${host.now()}`
      },
      { kind: 'status', text, ...(tone ? { tone } : {}) },
      { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
}

/** Personal messages meet these refusals too; advise retry instead. */
const OWNERSHIP_REFUSALS = new Set([
  'agent_session_conflict',
  'agent_session_ownership_unknown',
  'execution_owner_reconciling'
])

export const RESTART_CONTINUATION_SUPERSEDED = 'agent_session_restart_work_superseded'

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
  /** Attribute host continuation/failure; older clients render tone as plain text. */
  note: (sessionId: string, text: string, tone?: 'error' | 'warning') => Promise<void>
  /** Required to report best-effort note failures. */
  logger: StructuredAgentSessionLogger
  /** Answer at acceptance; caller reports pre-acceptance refusal without duplicate retry notes. */
  answerAtAcceptance?: true
}

export type StartedStructuredAgentSessionContinuation =
  | { done: StructuredAgentSessionContinuationOutcome }
  | { verdict: () => Promise<StructuredAgentSessionContinuationOutcome> }

/** Return at handover/start failure, or optional acceptance; await provider verdict separately from batch slots. */
export async function startStructuredAgentSessionContinuation(
  deps: StructuredAgentSessionContinuationDeps,
  sessionId: string,
  marker: Pick<AgentSessionResumeMarker, 'activity'>,
  continuationId: string
): Promise<StartedStructuredAgentSessionContinuation> {
  let started: StartedStructuredAgentSessionContinuation
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
  const { verdict } = started
  return {
    verdict: async () => {
      const outcome = await verdict()
      await noteOutcome(deps, sessionId, outcome)
      return outcome
    }
  }
}

async function noteOutcome(
  deps: Pick<StructuredAgentSessionContinuationDeps, 'note' | 'logger'>,
  sessionId: string,
  result: StructuredAgentSessionContinuationOutcome
): Promise<void> {
  if (result.outcome === 'continued') {
    // Attribute only accepted dispatch; note failure must not turn delivered work into failure.
    try {
      await deps.note(sessionId, AGENT_SESSION_RESTART_CONTINUATION_NOTE)
    } catch {
      reportNoteFailed(deps, sessionId)
    }
  } else {
    await noteNotContinued(
      deps,
      sessionId,
      result.outcome !== 'refused'
        ? 'unconfirmed'
        : OWNERSHIP_REFUSALS.has(result.reason ?? '')
          ? 'not-connected'
          : 'refused'
    )
  }
}

/** Persist failure in chat beyond transient toast/dialog state. */
async function noteNotContinued(
  deps: Pick<StructuredAgentSessionContinuationDeps, 'note' | 'logger'>,
  sessionId: string,
  outcome: 'refused' | 'not-connected' | 'unconfirmed'
): Promise<void> {
  try {
    await (outcome === 'unconfirmed'
      ? deps.note(sessionId, AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE, 'warning')
      : deps.note(
          sessionId,
          outcome === 'refused'
            ? AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE
            : AGENT_SESSION_RESTART_NOT_CONNECTED_NOTE,
          'error'
        ))
  } catch {
    reportNoteFailed(deps, sessionId)
  }
}

async function sendContinuation(
  deps: StructuredAgentSessionContinuationDeps,
  sessionId: string,
  marker: Pick<AgentSessionResumeMarker, 'activity'>,
  continuationId: string
): Promise<StartedStructuredAgentSessionContinuation> {
  const fence = deps.currentFence(sessionId)
  if (fence === null) {
    return { done: { sessionId, outcome: 'refused', reason: 'agent_session_not_attached' } }
  }
  const { envelope, body } = restartContinuationEnvelope(sessionId, fence, marker, continuationId)
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
  const settle = async (handedOver: ContinuationSubmission | undefined) =>
    verdictOf(
      sessionId,
      // Initial acceptance is usually pending; settled provider state decides.
      (await deps.awaitSettlement(sessionId, clientMessageId).catch(() => undefined)) ??
        handedOver ??
        sent.value?.submission
    )
  if (deps.answerAtAcceptance) {
    // Startup may outlast the client’s wait; verdict notes report later refusal.
    return { verdict: async () => settle(await handOver()) }
  }
  const handedOver = await handOver()
  if (handedOver?.dispatchState === 'rejected') {
    return { done: refusedBy(sessionId, handedOver) }
  }
  return { verdict: () => settle(handedOver) }
}

/** Omit errors that may contain private recovery payloads. */
function reportNoteFailed(
  deps: Pick<StructuredAgentSessionContinuationDeps, 'logger'>,
  sessionId: string
): void {
  deps.logger.warn('writing a restart continuation note failed', {
    scope: 'restart-continuation-note',
    sessionId
  })
}
