// The effects behind send / cancel / respond / setOption.
//
// Admission (writer lease, idempotency) has already passed by the time anything
// here runs; these functions own only the journal writes and the adapter call,
// in that order. Journal first is deliberate: a crash between the two leaves a
// row the next attach settles as `unknown`, whereas the reverse would lose a
// turn the provider already accepted.

import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionCancelResult,
  AgentSessionSendResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import { DISPATCH_DOUBT_PERSISTENCE_FAILED } from '../agent-session-journal/journal-dispatch-doubt-reasons'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { latestJournalDispatchObservation } from '../agent-session-journal/journal-dispatch-observation'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAdapter,
  StructuredAgentSessionProviderChildPhase
} from './structured-agent-session-adapter'
import { providerStartupFailureRejection } from './structured-agent-session-dead-generation-settlement'
import { validatePendingPrompt } from './structured-agent-session-prompt-state'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import {
  AgentSessionPreDispatchError,
  AGENT_SESSION_ADMISSION_BARRIER_TIMEOUT_MS
} from './structured-agent-session-operation-settlement'
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
  /** Republishes state kept outside the journal, such as the record's options or rewind phase.
   *  Journal appends reach readers on their own. */
  publish: () => void
  /** Drains provider lifecycle already accepted by the execution host. */
  flushStreamedEvents: () => Promise<void>
  /** Re-derives authorization after submission persistence, immediately before provider dispatch. */
  beforeDispatch?: () => void
  /** What the host holds about the child this dispatch is for, read at the moment it is needed. */
  providerChildPhase?: () => StructuredAgentSessionProviderChildPhase | undefined
  now: () => number
}

export type TurnOutcome<TValue> =
  | { ok: true; value: TValue }
  | { ok: false; refusal: AgentSessionWireRefusal }

function invalid(message: string): { ok: false; refusal: AgentSessionWireRefusal } {
  return { ok: false, refusal: { code: 'agent_session_operation_invalid', message } }
}

/** A thrown adapter error is indistinguishable from a lost reply, so it settles as `unknown`
 *  rather than as a rejection — unless the child had not proven its start. Such a child has
 *  accepted nothing (input is written only after it initializes), so a dispatch it could not
 *  take is provably unwritten and is rejected with the cause the adapter gave. */
async function dispatchSafely(
  ctx: AgentSessionTurnContext,
  clientMessageId: string,
  body: AgentJournalMessageItem,
  requestedAt: number | undefined
): Promise<AgentSessionDispatchOutcome> {
  try {
    return await ctx.adapter.dispatch({
      sessionId: ctx.sessionId,
      clientMessageId,
      body,
      fence: ctx.fence,
      ...(ctx.beforeDispatch ? { beforeDispatch: async () => ctx.beforeDispatch?.() } : {}),
      ...(requestedAt === undefined ? {} : { requestedAt })
    })
  } catch (error) {
    if (error instanceof AgentSessionPreDispatchError) {
      throw error
    }
    if (ctx.providerChildPhase?.() === 'starting') {
      return { state: 'rejected', reason: providerStartupFailureRejection(error) }
    }
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
}

/**
 * One id, one delivery. A submission that already exists replays its recorded
 * outcome and NEVER goes back on the wire, whatever state it is in and whatever
 * `retryUnknown` the client sent: `unknown` cannot prove non-delivery — that is
 * the whole content of the word — and one message reached the model five times
 * when this was a judgement call instead of an invariant. A distinct send after
 * a terminal rejection uses a fresh id, which is a first delivery.
 */
export async function performSend(
  ctx: AgentSessionTurnContext,
  input: {
    clientMessageId: string
    payloadFingerprint: string
    body: AgentJournalMessageItem
  }
): Promise<TurnOutcome<AgentSessionSendResult>> {
  const existing = ctx.journal
    .submissions()
    .find((entry) => entry.clientMessageId === input.clientMessageId)
  if (existing && existing.payloadFingerprint !== input.payloadFingerprint) {
    return invalid(`Message id ${input.clientMessageId} was already used for another send.`)
  }
  if (existing) {
    return {
      ok: true,
      value: { clientMessageId: input.clientMessageId, submission: existing }
    }
  }
  try {
    await ctx.journal.appendSubmission({ ...input, fence: ctx.fence })
  } catch {
    return invalid('The message could not be recorded and was not sent.')
  }

  // The row just written is the send's instant on the host clock; the turn this
  // dispatch opens records it so the live counter never re-anchors at turn-open.
  const requestedAt = ctx.journal
    .submissions()
    .find((entry) => entry.clientMessageId === input.clientMessageId)?.submittedAt
  const outcome = await dispatchSafely(ctx, input.clientMessageId, input.body, requestedAt).catch(
    async (error: unknown) => {
      if (error instanceof AgentSessionPreDispatchError) {
        const recorded = await withTimeout(
          ctx.journal
            .resolveDispatch({
              clientMessageId: input.clientMessageId,
              state: 'rejected',
              reason: error.message,
              fence: ctx.fence
            })
            .then(() => true),
          AGENT_SESSION_ADMISSION_BARRIER_TIMEOUT_MS,
          false
        )
        if (!recorded) {
          console.warn('[structured-agent-session] pre-dispatch refusal persistence failed')
        }
      }
      throw error
    }
  )
  // An admission needs no dispatch row: the submission is already pending.
  if (outcome.state === 'admitted') {
    return {
      ok: true,
      value: {
        clientMessageId: input.clientMessageId,
        submission: requireSubmission(ctx, input.clientMessageId)
      }
    }
  }
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
    // explicitly replayable.
    try {
      await ctx.journal.resolveDispatch({
        clientMessageId: input.clientMessageId,
        state: 'unknown',
        reason: DISPATCH_DOUBT_PERSISTENCE_FAILED,
        fence: ctx.fence
      })
    } catch {
      // Nothing further to record; the pending row is settled on the next attach.
    }
    throw error
  }
  return {
    ok: true,
    value: {
      clientMessageId: input.clientMessageId,
      submission: requireSubmission(ctx, input.clientMessageId)
    }
  }
}

function requireSubmission(
  ctx: AgentSessionTurnContext,
  clientMessageId: string
): AgentJournalSubmission {
  const submission = ctx.journal
    .submissions()
    .find((entry) => entry.clientMessageId === clientMessageId)
  if (!submission) {
    throw new Error('agent_session_submission_lost')
  }
  return submission
}

export async function performCancel(
  ctx: AgentSessionTurnContext,
  input: {
    clientOperationId: string
    turnId: string
    scope?: 'background-tasks'
    taskId?: string
    prompt?: { itemId: string; expectedRevision: number }
  }
): Promise<TurnOutcome<AgentSessionCancelResult>> {
  if (input.prompt) {
    const validated = validatePendingPrompt(ctx, input.prompt)
    if (!validated.ok) {
      return validated
    }
  }
  let cancelled = false
  let note = 'Cancellation requested.'
  try {
    const dispatchStatus = latestJournalDispatchObservation(ctx.journal, ctx.fence)
    cancelled = input.scope
      ? (
          await ctx.adapter.stopBackgroundTasks?.({
            sessionId: ctx.sessionId,
            fence: ctx.fence,
            ...(input.taskId ? { taskId: input.taskId } : {})
          })
        )?.cancelled === true
      : (
          await ctx.adapter.cancelTurn({
            sessionId: ctx.sessionId,
            turnId: input.turnId,
            fence: ctx.fence,
            // The journal is what the client read to name a turn, so it is what judges the request.
            resolveLiveTurnId: () => ctx.journal.activeTurnId(),
            ...(dispatchStatus ? { dispatchStatus } : {}),
            ...(input.prompt ? { prompt: { itemId: input.prompt.itemId } } : {})
          })
        ).cancelled
    if (!cancelled) {
      note = 'The provider had already finished this turn.'
    }
  } catch (error) {
    if (input.prompt) {
      throw error
    }
    note = `Cancellation was not confirmed: ${
      error instanceof Error ? error.message : String(error)
    }`
  }
  if (cancelled && input.prompt) {
    await ctx.flushStreamedEvents()
  }
  if (input.scope) {
    return { ok: true, value: { turnId: input.turnId, cancelled } }
  }
  // Keyed by the operation id so a replayed cancel upserts one item, not two.
  await appendStatus(ctx, input.clientOperationId, note)
  return { ok: true, value: { turnId: input.turnId, cancelled } }
}
