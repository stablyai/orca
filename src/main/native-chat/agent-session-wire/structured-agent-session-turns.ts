// The effects behind send / cancel / respond / setOption.
//
// Admission (lease, fence, idempotency) has already passed by the time anything
// here runs; these functions own only the journal writes and the adapter call,
// in that order. Journal first is deliberate: a crash between the two leaves a
// row the next attach settles as `unknown`, whereas the reverse would lose a
// turn the provider already accepted.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentSessionCancelResult,
  AgentSessionSendResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import {
  dispatchReservationId,
  JOURNAL_DISPATCH_RESERVATION_BYTES,
  JOURNAL_TURN_TERMINAL_RESERVATION_BYTES,
  lifecycleReservationIdForItem,
  tentativeTurnReservationId
} from '../agent-session-journal/journal-lifecycle-capacity'

export { performSetOption } from './structured-agent-session-turns-options'
export { performPrompt } from './structured-agent-session-turns-prompt'

export type AgentSessionTurnContext = {
  sessionId: string
  journal: AgentSessionJournal
  fence: number
  adapter: StructuredAgentSessionAdapter
  persistedOptions?: Readonly<Record<string, string>>
  persistOptions: (options: Readonly<Record<string, string>>) => Promise<void>
  /** Opaque client identity recorded as the resolver of a prompt. */
  resolvedBy: string
  publish: () => void
  now: () => number
}

export type TurnOutcome<TValue> =
  | { ok: true; value: TValue }
  | { ok: false; refusal: AgentSessionWireRefusal }

function invalid(message: string): { ok: false; refusal: AgentSessionWireRefusal } {
  return { ok: false, refusal: { code: 'agent_session_operation_invalid', message } }
}

/** A thrown adapter error is indistinguishable from a lost reply, so it settles
 *  as `unknown` rather than as a rejection. */
async function dispatchSafely(
  ctx: AgentSessionTurnContext,
  clientMessageId: string,
  body: AgentJournalMessageItem
): Promise<AgentSessionDispatchOutcome> {
  try {
    return await ctx.adapter.dispatch({
      sessionId: ctx.sessionId,
      clientMessageId,
      body,
      fence: ctx.fence
    })
  } catch (error) {
    return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) }
  }
}

async function appendStatus(
  ctx: AgentSessionTurnContext,
  clientMessageId: string,
  text: string
): Promise<void> {
  await ctx.journal.appendItem(
    { provider: 'orca', clientMessageId },
    { kind: 'status', text },
    { fence: ctx.fence }
  )
  ctx.publish()
}

export async function performSend(
  ctx: AgentSessionTurnContext,
  input: {
    clientMessageId: string
    payloadFingerprint: string
    body: AgentJournalMessageItem
    retryUnknown?: true
  }
): Promise<TurnOutcome<AgentSessionSendResult>> {
  const existing = ctx.journal
    .submissions()
    .find((entry) => entry.clientMessageId === input.clientMessageId)
  if (existing && existing.payloadFingerprint !== input.payloadFingerprint) {
    return invalid(`Message id ${input.clientMessageId} was already used for another send.`)
  }
  if (existing && !(input.retryUnknown && existing.dispatchState === 'unknown')) {
    return {
      ok: true,
      value: { clientMessageId: input.clientMessageId, submission: existing }
    }
  }
  if (!(input.retryUnknown && existing?.dispatchState === 'unknown')) {
    const dispatchReservation = dispatchReservationId(input.clientMessageId)
    const tentativeReservation = tentativeTurnReservationId(input.clientMessageId)
    const dispatchReserved = await ctx.journal.reserveLifecycleCapacity({
      id: dispatchReservation,
      bytes: JOURNAL_DISPATCH_RESERVATION_BYTES,
      appendSlots: 1
    })
    const turnReserved =
      dispatchReserved &&
      (await ctx.journal.reserveLifecycleCapacity({
        id: tentativeReservation,
        bytes: JOURNAL_TURN_TERMINAL_RESERVATION_BYTES,
        appendSlots: 1
      }))
    if (!dispatchReserved || !turnReserved) {
      await ctx.journal.releaseLifecycleCapacity(dispatchReservation)
      await ctx.journal.releaseLifecycleCapacity(tentativeReservation)
      return invalid('The session does not have enough durable capacity to start another turn.')
    }
    try {
      await ctx.journal.appendSubmission({ ...input, fence: ctx.fence })
    } catch (error) {
      await ctx.journal.releaseLifecycleCapacity(dispatchReservation)
      await ctx.journal.releaseLifecycleCapacity(tentativeReservation)
      throw error
    }
    ctx.publish()
  } else {
    const retryReserved = await ctx.journal.reserveLifecycleCapacity({
      id: dispatchReservationId(input.clientMessageId),
      bytes: JOURNAL_DISPATCH_RESERVATION_BYTES,
      appendSlots: 1
    })
    if (!retryReserved) {
      return invalid('The session does not have enough durable capacity to retry this turn.')
    }
  }

  const outcome = await dispatchSafely(ctx, input.clientMessageId, input.body)
  try {
    await ctx.journal.resolveDispatch(
      outcome.state === 'accepted'
        ? {
            clientMessageId: input.clientMessageId,
            state: 'accepted',
            providerIdentity: outcome.providerIdentity,
            fence: ctx.fence
          }
        : {
            clientMessageId: input.clientMessageId,
            state: outcome.state,
            reason: outcome.reason,
            fence: ctx.fence
          }
    )
  } catch (error) {
    // A failed resolution must not strand a pending row; an unknown result is
    // explicitly replayable and keeps tentative capacity for that retry.
    try {
      await ctx.journal.resolveDispatch({
        clientMessageId: input.clientMessageId,
        state: 'unknown',
        reason: 'dispatch_result_persistence_failed',
        fence: ctx.fence,
        recovered: true
      })
    } catch {
      await ctx.journal.releaseLifecycleCapacity(dispatchReservationId(input.clientMessageId))
    }
    ctx.publish()
    throw error
  }
  if (outcome.state === 'accepted') {
    // Codex publishes its running lifecycle row under the legacy turn identity,
    // while the dispatch response identifies the user's message item.  Bind the
    // tentative turn reservation to the lifecycle identity so a response that
    // wins the race with turn/started cannot strand that row at the quota edge.
    const reservationTarget =
      outcome.providerIdentity.provider === 'codex'
        ? {
            provider: 'legacy' as const,
            agent: 'codex' as const,
            sessionId: ctx.sessionId,
            recordId: `turn-lifecycle:${outcome.providerIdentity.turnId}`
          }
        : outcome.providerIdentity
    await ctx.journal.transferLifecycleCapacity(
      tentativeTurnReservationId(input.clientMessageId),
      lifecycleReservationIdForItem(
        ctx.journal.canonicalItemId(agentJournalItemKey(reservationTarget))
      )
    )
  } else if (outcome.state === 'rejected') {
    await ctx.journal.releaseLifecycleCapacity(tentativeTurnReservationId(input.clientMessageId))
  }
  ctx.publish()

  const submission = ctx.journal
    .submissions()
    .find((entry) => entry.clientMessageId === input.clientMessageId)
  if (!submission) {
    throw new Error('agent_session_submission_lost')
  }
  return { ok: true, value: { clientMessageId: input.clientMessageId, submission } }
}

export async function performCancel(
  ctx: AgentSessionTurnContext,
  input: { clientOperationId: string; turnId: string }
): Promise<TurnOutcome<AgentSessionCancelResult>> {
  let cancelled = false
  let note = 'Cancellation requested.'
  try {
    cancelled = (
      await ctx.adapter.cancelTurn({
        sessionId: ctx.sessionId,
        turnId: input.turnId,
        fence: ctx.fence
      })
    ).cancelled
    if (!cancelled) {
      note = 'The provider had already finished this turn.'
    }
  } catch (error) {
    note = `Cancellation was not confirmed: ${
      error instanceof Error ? error.message : String(error)
    }`
  }
  // Keyed by the operation id so a replayed cancel upserts one item, not two.
  await appendStatus(ctx, input.clientOperationId, note)
  return { ok: true, value: { turnId: input.turnId, cancelled } }
}
