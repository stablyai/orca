// The effects behind send / cancel / respond / setOption.
//
// Admission (writer lease, idempotency) has already passed by the time anything
// here runs; these functions own only the journal writes and the adapter call,
// in that order. Journal first is deliberate: a crash between the two leaves a
// row the next attach settles as `unknown`, whereas the reverse would lose a
// turn the provider already accepted.

import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionMessageSource } from '../../../shared/agent-session-message-source'
import {
  refuse,
  type AgentSessionRefusalReason,
  type AgentSessionSendResult,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import { isAgentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { DISPATCH_DOUBT_PERSISTENCE_FAILED } from '../agent-session-journal/journal-dispatch-doubt-reasons'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalOperationReceipt } from '../agent-session-journal/journal-row-writer'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAdapter,
  StructuredAgentSessionProviderChildPhase
} from './structured-agent-session-adapter'
import { structuredAgentSessionStartFailure } from './structured-agent-session-failure-text'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  handOverStructuredAgentSessionCommand,
  structuredAgentSessionHandoverOrigin,
  type StructuredAgentSessionCommandHandoverContext
} from './structured-agent-session-command-turn'
import {
  classifyJournalOpenFailure,
  isJournalWrittenByNewerOrca,
  journalOpenRefusal
} from '../agent-session-journal/journal-open-failure'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import { isAgentSessionAttachmentExpiredError } from '../agent-session-attachments/agent-session-attachment-claims'
import type { StructuredAgentRegistry } from './structured-agent-registry'
export { performSetOption } from './structured-agent-session-turns-options'
export { performPrompt } from './structured-agent-session-turns-prompt'
export { performCancel } from './structured-agent-session-turns-cancel'

export type AgentSessionTurnContext = {
  sessionId: string
  journal: AgentSessionJournal
  fence: number
  adapter: StructuredAgentSessionAdapter
  /** What each agent declares; the session's own answer is `agents.capabilities(agent)`. */
  agents: StructuredAgentRegistry
  /** The session's agent. */
  agent: string
  logger: StructuredAgentSessionLogger
  persistedOptions?: Readonly<Record<string, string>>
  persistOptions: (options: Readonly<Record<string, string>>) => Promise<void>
  /** Opaque client identity recorded as the resolver of a prompt. */
  resolvedBy: string
  /** Republishes state kept outside the journal, such as the record's options or rewind phase.
   *  Journal appends reach readers on their own. */
  publish: () => void
  /** What the host holds about the child this dispatch is for, read at the moment it is needed. */
  providerChildPhase?: () => StructuredAgentSessionProviderChildPhase | undefined
  /** Who a Stop's refusal row names. */
  failureTextContext?: AgentSessionFailureWordsContext
  /** The operation's success, committed with the row that accepts it (`MutationPlan.settlesWithWrite`). */
  operationReceipt?: JournalOperationReceipt
  now: () => number
}

export type TurnOutcome<TValue> =
  | { ok: true; value: TValue }
  | { ok: false; refusal: AgentSessionWireRefusal }

function invalid(
  reason: AgentSessionRefusalReason<'agent_session_operation_invalid'>,
  message: string
): { ok: false; refusal: AgentSessionWireRefusal } {
  return { ok: false, refusal: refuse('agent_session_operation_invalid', { reason }, message) }
}

/** A message naming an attachment this host no longer stores is refused whole, before delivery. */
export function agentSessionAttachmentExpiredRefusal(): {
  ok: false
  refusal: AgentSessionWireRefusal
} {
  return invalid(
    'attachmentExpired',
    'A chat attachment in this message is no longer stored on the host, so it was not sent.'
  )
}

/** A thrown adapter error is indistinguishable from a lost reply, so it settles as `unknown`
 *  rather than as a rejection — unless the child had not proven its start. A dispatch to such a
 *  child throws only when the start failed before the write (a write's own failure is an outcome,
 *  not a throw), so it is provably unwritten and is rejected with the cause the adapter gave. */
async function dispatchSafely(
  ctx: AgentSessionHandoverContext,
  clientMessageId: string,
  body: AgentJournalMessageItem,
  requestedAt: number
): Promise<AgentSessionDispatchOutcome> {
  try {
    return await ctx.adapter.dispatch({
      sessionId: ctx.sessionId,
      clientMessageId,
      body,
      fence: ctx.fence,
      requestedAt
    })
  } catch (error) {
    if (ctx.providerChildPhase?.() === 'starting') {
      return {
        state: 'rejected',
        ...structuredAgentSessionStartFailure({ error }, ctx.failureTextContext)
      }
    }
    return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * One id, one delivery. A submission that already exists replays its recorded
 * outcome and NEVER goes back on the wire, whatever state it is in and whatever
 * `retryUnknown` the client sent: `unknown` cannot prove non-delivery — that is
 * the whole content of the word — and one message reached the model five times
 * when this was a judgement call instead of an invariant. A distinct send after
 * a terminal rejection uses a fresh id, which is a first delivery.
 *
 * Accepting only records the message; the session's delivery loop hands it over.
 */
export async function performSend(
  ctx: AgentSessionTurnContext,
  input: {
    clientMessageId: string
    payloadFingerprint: string
    body: AgentJournalMessageItem
    /** Who asked for the turn; absent on callers that predate it. */
    origin?: 'client' | 'host'
    /** Who it is from; the submission keeps the kind only. */
    source?: AgentSessionMessageSource
  }
): Promise<TurnOutcome<AgentSessionSendResult>> {
  const existing = ctx.journal
    .submissions()
    .find((entry) => entry.clientMessageId === input.clientMessageId)
  if (existing && existing.payloadFingerprint !== input.payloadFingerprint) {
    return invalid(
      'messageIdReused',
      `Message id ${input.clientMessageId} was already used for another send.`
    )
  }
  if (existing) {
    return {
      ok: true,
      value: { clientMessageId: input.clientMessageId, submission: existing }
    }
  }
  try {
    await ctx.journal.appendSubmission(
      { ...input, fence: ctx.fence, handoverRecorded: true },
      undefined,
      ctx.operationReceipt
    )
  } catch (error) {
    if (isAgentSessionAttachmentExpiredError(error)) {
      return agentSessionAttachmentExpiredRefusal()
    }
    // Damage SQLite proves is the chat's, and no retry writes past it: say so, as an open does. So
    // does a chat holding a newer Orca's rows, which only an update writes past, and a refusal the
    // journal already classified (a failed transaction that will not roll back).
    if (
      isAgentSessionRefusalError(error) ||
      classifyJournalOpenFailure(error) === 'journalCorrupt' ||
      isJournalWrittenByNewerOrca(error)
    ) {
      return { ok: false, refusal: journalOpenRefusal(error) }
    }
    return invalid('journalWriteFailed', 'The message could not be recorded and was not sent.')
  }
  return {
    ok: true,
    value: {
      clientMessageId: input.clientMessageId,
      submission: requireSubmission(ctx, input.clientMessageId)
    }
  }
}

export type AgentSessionHandoverContext = StructuredAgentSessionCommandHandoverContext

/**
 * Hands one queued submission to the provider. The `dispatch{pending}` row goes first: a crash
 * after it leaves a message in doubt, never one that reads as queued and so provably unwritten.
 */
export async function handOverSubmission(
  ctx: AgentSessionHandoverContext,
  submission: AgentJournalSubmission
): Promise<void> {
  const { clientMessageId } = submission
  const body = ctx.journal.itemBody(agentJournalSubmissionKey(clientMessageId))
  if (body?.kind !== 'message') {
    await ctx.journal.resolveDispatch({
      clientMessageId,
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('hostFault'), { surface: 'rejection' }),
      fence: ctx.fence
    })
    return
  }
  if (body.command) {
    await handOverStructuredAgentSessionCommand(ctx, submission, body)
    return
  }
  // The message joins the turn running at handover, a steer, or opens its own.
  await ctx.journal.resolveDispatch({
    clientMessageId,
    state: 'pending',
    fence: ctx.fence,
    turnScope: ctx.journal.liveTurnScope()
  })
  // The handover row's instant on the host clock; the turn this dispatch opens records it so the
  // live counter never re-anchors at turn-open.
  const outcome = await dispatchSafely(
    ctx,
    clientMessageId,
    body,
    structuredAgentSessionHandoverOrigin(ctx.journal, submission)
  )
  // An admission needs no dispatch row: the submission is already pending.
  if (outcome.state === 'admitted') {
    return
  }
  try {
    await ctx.journal.resolveDispatch(
      outcome.state === 'accepted'
        ? {
            clientMessageId,
            state: 'accepted',
            providerIdentity: outcome.providerIdentity,
            fence: ctx.fence
          }
        : outcome.state === 'rejected'
          ? {
              clientMessageId,
              state: 'rejected',
              reason: outcome.reason,
              rejection: outcome.rejection,
              ...(outcome.answeredInTurn ? { answeredInTurn: outcome.answeredInTurn } : {}),
              fence: ctx.fence
            }
          : { clientMessageId, state: 'unknown', reason: outcome.reason, fence: ctx.fence }
    )
  } catch (error) {
    // A failed resolution must not strand a pending row; an unknown result is
    // explicitly replayable.
    try {
      await ctx.journal.resolveDispatch({
        clientMessageId,
        state: 'unknown',
        reason: DISPATCH_DOUBT_PERSISTENCE_FAILED,
        fence: ctx.fence
      })
    } catch {
      // Nothing further to record; the pending row is settled on the next open.
    }
    throw error
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
