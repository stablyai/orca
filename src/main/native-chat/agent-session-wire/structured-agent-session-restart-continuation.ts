// Asking an interrupted agent to carry on, on the user's opt-in.
//
// The continuation is a send like any other: accepted into the conversation, and delivered by the
// session's delivery loop, which starts the agent. Both the restart prompt and an opted-in launch
// come here, so a SETTING can reach this send — acceptable because the work is the user's own, the
// message asks the agent to verify its last action before repeating it, and the launch toast
// reports what happened.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  AGENT_SESSION_RESTART_CONTINUATION_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE,
  AGENT_SESSION_RESTART_NOT_CONNECTED_NOTE
} from '../../../shared/agent-session-restart-continuation'
import { AgentSessionPreDispatchError } from './structured-agent-session-operation-settlement'
import { restartContinuationEnvelope } from './structured-agent-session-restart-continuation-envelope'
import type { AgentSessionResumeMarker } from '../../../shared/agent-session-resume-marker'

/**
 * All four dispatch states are preserved, never collapsed into transport success.
 *
 * The send layer answers `ok: true` as soon as Orca OWNS the message — a rejected or unverifiable
 * provider dispatch is recorded inside the submission, not on the envelope. Reading only the
 * envelope reports a refused `turn/start` as continued and stamps the journal saying so.
 *
 *   accepted  -> `continued`, and only this appends the attribution note
 *   pending   -> `pending`: journaled and handed off, not yet confirmed by the provider
 *   unknown   -> `unknown`: delivery unverifiable, never reported as either success or failure
 *   rejected  -> `refused`, carrying the provider's reason
 */
export type StructuredAgentSessionContinuationOutcome = {
  sessionId: string
  outcome: 'continued' | 'pending' | 'unknown' | 'refused'
  reason?: string
}

/** The slice of the host one continuation needs. Structural so this module never imports the host. */
export type StructuredAgentSessionContinuationHost = {
  sessions: ReadonlyMap<string, { journal: AgentSessionJournal }>
  /** The fence a conversation write carries; null when this host has no record of the session.
   *  The send opens the conversation itself, so a closed one still answers. */
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
  onNoteFailed: (sessionId: string, error: unknown) => void
  now: () => number
  /** Whether the marker is still an offer. Asked at acceptance, inside the session lock, so the
   *  first message accepted since the restart decides: the user's, or this continuation. */
  stillResumable: (marker: AgentSessionResumeMarker) => boolean
}

/** Binds one continuation to the host: the superseded check before dispatch, the settlement
 *  waiter for the verdict, and the journal note that attributes the send to Orca. */
export function restartContinuationDeps(
  host: StructuredAgentSessionContinuationHost,
  marker: AgentSessionResumeMarker
): StructuredAgentSessionContinuationDeps {
  return {
    currentFence: host.conversationFence,
    send: (input) =>
      host.send({
        ...input,
        beforeRun: () => {
          if (!host.stillResumable(marker)) {
            throw new RestartContinuationSupersededError()
          }
        }
      }),
    awaitSettlement: async (sessionId, clientMessageId) =>
      (await host.awaitSendSettlement(sessionId, clientMessageId))?.value.submission,
    awaitHandedOver: async (sessionId, clientMessageId) =>
      (await host.awaitSendHandedOver(sessionId, clientMessageId))?.value.submission,
    onNoteFailed: host.onNoteFailed,
    note: restartNoteWriter(host)
  }
}

/** Writes a host-authored status note into the chat. */
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
      { provider: 'orca', clientMessageId: `restart-continuation:${sessionId}:${host.now()}` },
      { kind: 'status', text, ...(tone ? { tone } : {}) },
      { fence }
    )
  }
}

/** Refusals the user's own message would meet as well; the restart list says to retry these. */
const OWNERSHIP_REFUSALS = new Set([
  'agent_session_conflict',
  'agent_session_ownership_unknown',
  'execution_owner_reconciling'
])

/** The user's own message was accepted first; the offer is spent, and nothing failed. */
export const RESTART_CONTINUATION_SUPERSEDED = 'agent_session_restart_work_superseded'

/** Only this pre-dispatch failure proves a thrown send did not deliver. */
export class RestartContinuationSupersededError extends AgentSessionPreDispatchError {
  constructor() {
    super(RESTART_CONTINUATION_SUPERSEDED)
    this.name = 'RestartContinuationSupersededError'
  }
}

type ContinuationSubmission = { dispatchState?: string; reason?: string | null }

export type StructuredAgentSessionContinuationDeps = {
  /** Runtime fence as it stands now; null when this host has no record of the session. */
  currentFence: (sessionId: string) => number | null
  send: (input: {
    envelope: AgentSessionMutationEnvelope
    body: AgentJournalMessageItem
  }) => Promise<{
    ok: boolean
    refusal?: { code: string }
    /** The submission is where the provider's answer lives; the envelope only says Orca took it. */
    value?: { submission?: { dispatchState?: string; reason?: string | null } }
  }>
  /**
   * Waits for that send's dispatch to stop being `pending`, through the host's existing settlement
   * waiter. Send RETURNS while the dispatch is still pending — that is the normal successful path —
   * so the value on the send result is a starting state, not a verdict.
   *
   * Resolves undefined when nothing settled it in time, which is genuinely unverifiable.
   */
  awaitSettlement: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<ContinuationSubmission | undefined>
  /** Waits until the send is handed to a started agent or rejected. Undefined when the wait ended
   *  first — the session closed, or too many waited — which proves neither. */
  awaitHandedOver: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<ContinuationSubmission | undefined>
  /** Records a host-authored journal note: that this send was Orca's, not the user's, or that the
   *  chat did not carry on. `tone` is a display hint older clients render as plain text. */
  note: (sessionId: string, text: string, tone?: 'error' | 'warning') => Promise<void>
  /** Reports a note that could not be written. The note is best effort, but its failure is not
   *  allowed to be silent — a swallowed append is how this regressed unnoticed once already. */
  onNoteFailed: (sessionId: string, error: unknown) => void
}

/** A continuation handed to its agent, or already decided. */
export type StartedStructuredAgentSessionContinuation =
  | { done: StructuredAgentSessionContinuationOutcome }
  | { verdict: () => Promise<StructuredAgentSessionContinuationOutcome> }

/**
 * Sends the continuation to ONE session and returns once the agent has taken it or its start
 * failed — the point a restart batch counts a start as done. What the provider then answered is
 * the `verdict`, awaited separately so a slow answer does not hold the batch.
 */
export async function startStructuredAgentSessionContinuation(
  deps: StructuredAgentSessionContinuationDeps,
  sessionId: string,
  marker: AgentSessionResumeMarker,
  /** This action's continuation, as its offer recorded it. */
  continuationId: string
): Promise<StartedStructuredAgentSessionContinuation> {
  let started: StartedStructuredAgentSessionContinuation
  try {
    started = await sendContinuation(deps, sessionId, marker, continuationId)
  } catch (error) {
    // The user's own message came first: nothing failed, so the chat says nothing.
    if (!(error instanceof RestartContinuationSupersededError)) {
      await noteNotContinued(deps, sessionId, 'refused')
    }
    throw error
  }
  if ('done' in started) {
    await noteOutcome(deps, sessionId, started.done)
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
  deps: Pick<StructuredAgentSessionContinuationDeps, 'note' | 'onNoteFailed'>,
  sessionId: string,
  result: StructuredAgentSessionContinuationOutcome
): Promise<void> {
  if (result.outcome === 'continued') {
    // Only an accepted dispatch gets the note: it is a durable claim that Orca asked this agent to
    // carry on. Best effort — losing it must not turn a delivered continuation into a failure.
    try {
      await deps.note(sessionId, AGENT_SESSION_RESTART_CONTINUATION_NOTE)
    } catch (error) {
      deps.onNoteFailed(sessionId, error)
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

/** The chat itself carries the failure, so it survives the toast, a dismissed record and a restart,
 *  and the user's next message is what moves past it. */
async function noteNotContinued(
  deps: Pick<StructuredAgentSessionContinuationDeps, 'note' | 'onNoteFailed'>,
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
  } catch (error) {
    deps.onNoteFailed(sessionId, error)
  }
}

async function sendContinuation(
  deps: StructuredAgentSessionContinuationDeps,
  sessionId: string,
  marker: AgentSessionResumeMarker,
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
    console.warn('[structured-agent-session] restart continuation send failed')
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
        reason: sent.refusal?.code ?? 'agent_session_send_failed'
      }
    }
  }
  const clientMessageId = envelope.clientOperationId
  const handedOver = await deps.awaitHandedOver(sessionId, clientMessageId).catch(() => undefined)
  if (handedOver?.dispatchState === 'rejected') {
    return { done: refusedBy(sessionId, handedOver) }
  }
  return {
    verdict: async () =>
      verdictOf(
        sessionId,
        // The send result carries the dispatch as it stood when Orca took the message, which for
        // a normal successful send is `pending`, so the settled value is what decides.
        (await deps.awaitSettlement(sessionId, clientMessageId).catch(() => undefined)) ??
          handedOver ??
          sent.value?.submission
      )
  }
}

function refusedBy(
  sessionId: string,
  submission: ContinuationSubmission
): StructuredAgentSessionContinuationOutcome {
  return {
    sessionId,
    outcome: 'refused',
    reason: submission.reason ?? 'agent_session_dispatch_rejected'
  }
}

function verdictOf(
  sessionId: string,
  submission: ContinuationSubmission | undefined
): StructuredAgentSessionContinuationOutcome {
  const dispatch = submission?.dispatchState
  if (submission && dispatch === 'rejected') {
    return refusedBy(sessionId, submission)
  }
  if (dispatch === 'pending') {
    // Still pending after settlement gave up: handed off, never confirmed.
    return { sessionId, outcome: 'pending' }
  }
  // `unknown`, or a peer that reported no state at all: delivery is unverifiable, so this claims
  // neither success nor failure — and writes no note saying the agent was asked to continue.
  return dispatch === 'accepted'
    ? { sessionId, outcome: 'continued' }
    : { sessionId, outcome: 'unknown' }
}
