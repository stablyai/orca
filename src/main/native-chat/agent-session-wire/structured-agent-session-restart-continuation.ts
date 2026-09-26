// Asking an interrupted agent to carry on, on the user's opt-in.
//
// Reattaching and continuing are SEPARATE operations: `resume` reattaches and sends nothing; this
// adds one message on top of it. Both the restart prompt and an opted-in launch come here, so a
// SETTING can reach this send — acceptable because the work is the user's own, the message asks the
// agent to verify its last action before repeating it, and the launch toast reports what happened.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  AGENT_SESSION_RESTART_CONTINUATION_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_REFUSED_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE,
  AGENT_SESSION_RESTART_NOT_CONNECTED_NOTE,
  restartContinuationMessage
} from '../../../shared/agent-session-restart-continuation'
import { AgentSessionPreDispatchError } from './structured-agent-session-operation-settlement'
import { createHash } from 'node:crypto'
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
  sessions: ReadonlyMap<string, { journal: AgentSessionJournal; fence: number }>
  send: (input: {
    envelope: AgentSessionMutationEnvelope
    body: AgentJournalMessageItem
    beforeRun?: () => void
  }) => Promise<AgentSessionMutationResult<AgentSessionSendResult>>
  awaitSendSettlement: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<{ value: AgentSessionSendResult } | undefined>
  onNoteFailed: (sessionId: string, error: unknown) => void
  publish: (sessionId: string, journal: AgentSessionJournal) => void
  now: () => number
  /** Whether the marker is still an offer, with the continuation's own submission set aside.
   *  Re-asked right before dispatch, so a newer user message refuses the send; a provider turn
   *  running then does not, since both providers queue a message sent mid-turn. */
  stillResumable: (
    marker: AgentSessionResumeMarker,
    options: { pendingContinuationId: string }
  ) => boolean
}

/** Binds one continuation to the host: the superseded check before dispatch, the settlement
 *  waiter for the verdict, and the journal note that attributes the send to Orca. */
export function restartContinuationDeps(
  host: StructuredAgentSessionContinuationHost,
  marker: AgentSessionResumeMarker
): StructuredAgentSessionContinuationDeps {
  return {
    currentFence: (sessionId) => host.sessions.get(sessionId)?.fence ?? null,
    send: (input) =>
      host.send({
        ...input,
        beforeRun: () => {
          if (
            !host.stillResumable(marker, {
              pendingContinuationId: input.envelope.clientOperationId
            })
          ) {
            throw new RestartContinuationSupersededError()
          }
        }
      }),
    awaitSettlement: async (sessionId, clientMessageId) =>
      (await host.awaitSendSettlement(sessionId, clientMessageId))?.value.submission,
    onNoteFailed: host.onNoteFailed,
    note: restartNoteWriter(host)
  }
}

/** The note for a reattach that failed before any continuation was attempted. */
export function noteRestartReattachFailed(
  host: StructuredAgentSessionContinuationHost,
  sessionId: string
): Promise<void> {
  return noteNotContinued(
    { note: restartNoteWriter(host), onNoteFailed: host.onNoteFailed },
    sessionId,
    'not-connected'
  )
}

/** Writes a host-authored status note into the chat and publishes it to open panes. */
function restartNoteWriter(
  host: Pick<StructuredAgentSessionContinuationHost, 'sessions' | 'publish' | 'now'>
): StructuredAgentSessionContinuationDeps['note'] {
  return async (sessionId, text, tone) => {
    const session = host.sessions.get(sessionId)
    if (!session) {
      return
    }
    await session.journal.appendItem(
      { provider: 'orca', clientMessageId: `restart-continuation:${sessionId}:${host.now()}` },
      { kind: 'status', text, ...(tone ? { tone } : {}) },
      { fence: session.fence }
    )
    host.publish(sessionId, session.journal)
  }
}

/** Refusals the user's own message would meet as well; the restart list says to retry these. */
const OWNERSHIP_REFUSALS = new Set([
  'agent_session_conflict',
  'agent_session_ownership_unknown',
  'execution_owner_reconciling'
])

/** Only this pre-dispatch failure proves a thrown send did not deliver. */
export class RestartContinuationSupersededError extends AgentSessionPreDispatchError {
  constructor() {
    super('agent_session_restart_work_superseded')
    this.name = 'RestartContinuationSupersededError'
  }
}

/** The message body, built once so both the send and any test read the same text. */
export function restartContinuationBody(marker: AgentSessionResumeMarker): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: restartContinuationMessage(marker) }]
  }
}

/** The fence is read AFTER the reconnect: reattaching mints a new one, and the pre-reconnect value
 *  would be refused by the mutation admission. */
export function restartContinuationEnvelope(
  sessionId: string,
  fence: number,
  marker: AgentSessionResumeMarker
): { envelope: AgentSessionMutationEnvelope; body: AgentJournalMessageItem } {
  const body = restartContinuationBody(marker)
  return {
    body,
    envelope: {
      sessionId,
      // The same interrupted work must reach the durable ledger with the same message identity.
      clientOperationId: `${marker.recordedAt.toString().padStart(13, '0')}-${createHash('sha256')
        .update(
          JSON.stringify([
            marker.teardownId,
            sessionId,
            marker.work.kind,
            marker.work.id,
            marker.providerHandleRoot
          ])
        )
        .digest('hex')
        .slice(0, 32)}`,
      expectedRuntimeFence: fence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId,
        fields: { body }
      })
    }
  }
}

export type StructuredAgentSessionContinuationDeps = {
  /** Runtime fence as it stands now; null when the session is not attached. */
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
  ) => Promise<{ dispatchState?: string; reason?: string | null } | undefined>
  /** Records a host-authored journal note: that this send was Orca's, not the user's, or that the
   *  chat did not carry on. `tone` is a display hint older clients render as plain text. */
  note: (sessionId: string, text: string, tone?: 'error' | 'warning') => Promise<void>
  /** Reports a note that could not be written. The note is best effort, but its failure is not
   *  allowed to be silent — a swallowed append is how this regressed unnoticed once already. */
  onNoteFailed: (sessionId: string, error: unknown) => void
}

/**
 * Sends the continuation to ONE already-reconnected session.
 *
 * The caller must have reconnected it first: this deliberately does not reconnect, so that every
 * eligibility check, the admission gate and the consume-once ordering stay in the resume path and
 * are not re-implemented here.
 */
export async function continueStructuredAgentSessionAfterRestart(
  deps: StructuredAgentSessionContinuationDeps,
  sessionId: string,
  marker: AgentSessionResumeMarker
): Promise<StructuredAgentSessionContinuationOutcome> {
  let result: StructuredAgentSessionContinuationOutcome
  try {
    result = await sendContinuation(deps, sessionId, marker)
  } catch (error) {
    await noteNotContinued(deps, sessionId, 'refused')
    throw error
  }
  if (result.outcome !== 'continued') {
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
  return result
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
  marker: AgentSessionResumeMarker
): Promise<StructuredAgentSessionContinuationOutcome> {
  const fence = deps.currentFence(sessionId)
  if (fence === null) {
    return { sessionId, outcome: 'refused', reason: 'agent_session_not_attached' }
  }
  const { envelope, body } = restartContinuationEnvelope(sessionId, fence, marker)
  const sent = await deps.send({ envelope, body }).catch((error: unknown) => {
    if (error instanceof AgentSessionPreDispatchError) {
      throw error
    }
    // Persistence can fail after dispatch; a thrown send is not proof of non-delivery.
    console.warn('[structured-agent-session] restart continuation send failed')
    return null
  })
  if (!sent) {
    return { sessionId, outcome: 'unknown' }
  }
  if (!sent.ok) {
    return {
      sessionId,
      outcome: 'refused',
      reason: sent.refusal?.code ?? 'agent_session_send_failed'
    }
  }
  // The send result carries the dispatch as it stood when Orca took the message, which for a normal
  // successful send is `pending`. Judging it here would report every delivered continuation as
  // pending and never write the note, so the settled value is what decides.
  const submission =
    (await deps.awaitSettlement(sessionId, envelope.clientOperationId).catch(() => undefined)) ??
    sent.value?.submission
  const dispatch = submission?.dispatchState
  if (dispatch === 'rejected') {
    return {
      sessionId,
      outcome: 'refused',
      reason: submission?.reason ?? 'agent_session_dispatch_rejected'
    }
  }
  if (dispatch === 'pending') {
    // Still pending after settlement gave up: handed off, never confirmed.
    return { sessionId, outcome: 'pending' }
  }
  if (dispatch !== 'accepted') {
    // `unknown`, or a peer that reported no state at all. Delivery is unverifiable, so this claims
    // neither success nor failure — and writes no note saying the agent was asked to continue.
    return { sessionId, outcome: 'unknown' }
  }
  // Only an accepted dispatch gets the note: it is a durable claim that Orca asked this agent to
  // carry on, and it must not sit beside a message the provider refused or never confirmed. Best
  // effort beyond that — losing the note must not turn a delivered continuation into a failure —
  // but reported, never swallowed.
  try {
    await deps.note(sessionId, AGENT_SESSION_RESTART_CONTINUATION_NOTE)
  } catch (error) {
    deps.onNoteFailed(sessionId, error)
  }
  return { sessionId, outcome: 'continued' }
}
