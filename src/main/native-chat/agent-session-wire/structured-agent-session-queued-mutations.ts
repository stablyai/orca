// `agentSession.queuedMessageSend` / `agentSession.queuedMessageDelete`, and
// /clear's carry of the source's drafts to its replacement session. Settling
// operations stamp op-scoped tombstone receipts, so a lost acknowledgement
// replays from the rows themselves — never from the operation ledger, which
// records only that an operation happened. No mutation returns draft text:
// the published list is the one authority a client renders.

import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { agentSessionOperationKey } from '../../../shared/agent-session-operation-ledger'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionQueuedMessageDeleteResult,
  AgentSessionQueuedMessagesResumeResult,
  AgentSessionSendResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { QueuedMessageNotConsumableError } from '../agent-session-journal/journal-queued-messages'
import {
  isJournalWrittenByNewerOrca,
  journalOpenRefusal
} from '../agent-session-journal/journal-open-failure'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import { structuredQueueHold } from './structured-agent-session-queued-messages'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import {
  resumeStructuredQueue,
  structuredAgentSessionHostInstance
} from './structured-agent-session-queued-pause'
import { unsettledQueuedMessages } from './structured-agent-session-queued-stop'
import {
  mutateStructuredAgentSession,
  type StructuredAgentSessionMutationContext
} from './structured-agent-session-mutation-context'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import {
  openForWrite,
  structuredAgentSessionSendBlock
} from './structured-agent-session-send-preparation'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

function invalid(message: string): {
  ok: false
  refusal: { code: 'agent_session_operation_invalid'; message: string }
} {
  return { ok: false, refusal: { code: 'agent_session_operation_invalid', message } }
}

function submissionFor(
  ctx: AgentSessionTurnContext,
  clientMessageId: string
): AgentJournalSubmission | undefined {
  return ctx.journal.submissions().find((entry) => entry.clientMessageId === clientMessageId)
}

/** One transaction, stamped with the operation's caller-scoped key so a replay
 *  answers "spent" from the receipts. Withdrawal retires any hold in the same
 *  UPDATE, and the store's commit notification publishes the change. */
export async function withdrawQueuedMessagesForOperation(
  journal: AgentSessionJournal,
  input: {
    sessionId: string
    messageIds: readonly string[]
    callerKey: string
    operationId: string
  }
): Promise<QueuedMessageRow[]> {
  return journal.queuedMessages.withdraw({
    messageIds: input.messageIds,
    settledByOp: agentSessionOperationKey(input.callerKey, input.operationId)
  })
}

/**
 * /clear's carry: the source's unsettled drafts become rows on the replacement
 * session — the SAME for every client version, with no text on the wire — so the
 * cards stay visible where the user now is. The replacement's queue starts
 * paused ('cleared'), lifted exactly like a Stop's: the cards were written for the context /clear just
 * discarded, so they wait for the user's next turn there, or Resume, rather than
 * sending into the fresh context unasked. Each card records the conversation it
 * came from, which IS that pause, so the drain never sees a carried card unpaused
 * and no pause outlives the cards. Runs after the clear commits, opening the
 * replacement's conversation only when there are drafts to carry; the source
 * rows are then tombstoned. A command card (a waiting /compact) is tombstoned
 * without a copy. Bookkeeping around the clear: a failure, or a crash
 * before the carry, leaves the cards on the superseded source — whose
 * supersession fence already blocks the drain — reported, never gating the
 * clear. A crash between the copy and the tombstone leaves both, which the
 * fence also makes harmless: nothing is lost and nothing runs.
 */
export async function carryQueuedMessagesToClearReplacement(
  ctx: AgentSessionTurnContext,
  input: {
    replacementSessionId: string
    openReplacementJournal: () => Promise<AgentSessionJournal | undefined>
    callerKey: string
    operationId: string
  }
): Promise<void> {
  try {
    const rows = unsettledQueuedMessages(ctx.journal)
    if (rows.length === 0) {
      return
    }
    // A command belongs to the discarded context, so it is withdrawn instead of carried.
    const carried = rows.filter((row) => !row.body.command)
    if (carried.length > 0) {
      const replacement = await input.openReplacementJournal()
      if (!replacement) {
        throw new Error('the replacement journal is not open')
      }
      for (const row of carried) {
        // A returned card carries over as a plain waiting draft — its refusal
        // belonged to the source's submissions. The fingerprint is re-scoped to the
        // replacement, or its echo could never alias the sent bubble.
        await replacement.queuedMessages.insert({
          messageId: row.messageId,
          body: row.body,
          fingerprint: agentSessionSendBodyFingerprint(input.replacementSessionId, row.body),
          hostInstance: structuredAgentSessionHostInstance(),
          carriedFrom: ctx.sessionId
        })
      }
    }
    await withdrawQueuedMessagesForOperation(ctx.journal, {
      sessionId: ctx.sessionId,
      messageIds: rows.map((row) => row.messageId),
      callerKey: input.callerKey,
      operationId: input.operationId
    })
  } catch (error) {
    ctx.logger.warn("carrying queued drafts to /clear's replacement failed", {
      scope: 'clear-queued-carry',
      sessionId: ctx.sessionId,
      replacementSessionId: input.replacementSessionId,
      error
    })
  }
}

/** Draft actions run like any mutation: admitted on the session's lane, the
 *  conversation opened for the write. */
function mutateQueued<TValue>(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  envelope: AgentSessionMutationEnvelope,
  plan: MutationPlan<TValue>
): Promise<AgentSessionMutationResult<TValue>> {
  return mutateStructuredAgentSession(
    context,
    caller,
    envelope,
    { ...plan, run: (ctx) => refusingNewerOrcaJournal(plan.run(ctx)) },
    openForWrite(context, envelope)
  )
}

/** A newer Orca's journal refuses a draft write with the words a send gets there. */
async function refusingNewerOrcaJournal<TValue>(
  run: Promise<TurnOutcome<TValue>>
): Promise<TurnOutcome<TValue>> {
  try {
    return await run
  } catch (error) {
    if (isJournalWrittenByNewerOrca(error)) {
      return { ok: false, refusal: journalOpenRefusal(error) }
    }
    throw error
  }
}

/**
 * Send-now. It overrides ONLY queue policy — FIFO order, pause, the busy-turn
 * wait — through the same send block and pending-prompt gates as any send;
 * supersession, Stop and prepared commands are never overridden. The card goes
 * out under this operation's id, never its own, and the submission names it by
 * `queuedMessageId`; one id still means one delivery.
 */
export function sendQueuedStructuredAgentMessage(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope; messageId: string }
): Promise<AgentSessionMutationResult<AgentSessionSendResult>> {
  const { messageId } = params
  const operationId = params.envelope.clientOperationId
  const plan: MutationPlan<AgentSessionSendResult> = {
    method: 'agentSession.queuedMessageSend',
    fields: { messageId },
    conversationWrite: true,
    run: async (ctx): Promise<TurnOutcome<AgentSessionSendResult>> => {
      // A rerun of this operation after it consumed the card (its answer never
      // settled): answer with the submission it made, never append it again.
      const consumedHere = submissionFor(ctx, operationId)
      if (consumedHere?.queuedMessageId === messageId) {
        return { ok: true, value: { clientMessageId: operationId, submission: consumedHere } }
      }
      // The one queue gate; Send-now's override set is exactly `working` (plus
      // FIFO order and the stored hold, which the consume below clears).
      const record = context.deps.store.getRecord(ctx.sessionId)
      const hold = structuredQueueHold({ journal: ctx.journal, record, fence: ctx.fence })
      if (hold === 'blocked') {
        return structuredAgentSessionSendBlock(record) ?? invalid('This conversation cannot send.')
      }
      if (hold === 'prompt') {
        return invalid('Answer the pending request before sending this message.')
      }
      const row = ctx.journal.queuedMessages.get(messageId)
      if (!row) {
        return invalid('No queued message by that id.')
      }
      if (row.state === 'withdrawn') {
        return invalid('This queued message was withdrawn.')
      }
      if (row.state === 'dispatched') {
        // Already a submission — answer with it rather than sending twice.
        const submission = row.consumedAs === null ? undefined : submissionFor(ctx, row.consumedAs)
        return submission
          ? { ok: true, value: { clientMessageId: submission.clientMessageId, submission } }
          : invalid('This queued message was already sent.')
      }
      // A command never steers: handed over mid-turn it would only be refused. Clients offer its
      // Send only while the agent is idle; this answers an older one that offers it mid-turn.
      if (hold === 'working' && row.body.command) {
        return invalid("A command can't be sent while the agent is working.")
      }
      const submissionId = operationId
      try {
        await ctx.journal.appendSubmission(
          {
            clientMessageId: submissionId,
            // The person asked for this turn: a restart or a close keeps it as a card.
            origin: 'client',
            payloadFingerprint: row.fingerprint,
            body: row.body,
            fence: ctx.fence,
            handoverRecorded: true
          },
          {
            messageId,
            expect: row.state,
            settledByOp: agentSessionOperationKey(ctx.resolvedBy, operationId),
            hostInstance: structuredAgentSessionHostInstance()
          }
        )
      } catch (error) {
        if (error instanceof QueuedMessageNotConsumableError) {
          return invalid('The queued message changed underneath this Send; try again.')
        }
        throw error
      }
      const submission = submissionFor(ctx, submissionId)
      if (!submission) {
        throw new Error('agent_session_submission_lost')
      }
      context.wakeDelivery(ctx.sessionId)
      return { ok: true, value: { clientMessageId: submissionId, submission } }
    },
    replay: (ctx) => {
      const opKey = agentSessionOperationKey(ctx.resolvedBy, operationId)
      const row = ctx.journal.queuedMessages
        .receipts(opKey)
        .find((receipt) => receipt.messageId === messageId)
      if (!row || row.state !== 'dispatched') {
        return null
      }
      const submission = row.consumedAs === null ? undefined : submissionFor(ctx, row.consumedAs)
      return submission ? { clientMessageId: submission.clientMessageId, submission } : null
    }
  }
  return mutateQueued(context, caller, params.envelope, plan)
}

/** Delete = discard, with no body in the answer: the card leaving the published
 *  list IS the outcome, so a lost answer needs no re-ask. An Edit is the client
 *  copying the text it already renders, then this Delete. */
export function deleteQueuedStructuredAgentMessage(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope; messageId: string }
): Promise<AgentSessionMutationResult<AgentSessionQueuedMessageDeleteResult>> {
  const { messageId } = params
  const operationId = params.envelope.clientOperationId
  const plan: MutationPlan<AgentSessionQueuedMessageDeleteResult> = {
    method: 'agentSession.queuedMessageDelete',
    fields: { messageId },
    conversationWrite: true,
    run: async (ctx): Promise<TurnOutcome<AgentSessionQueuedMessageDeleteResult>> => {
      const row = ctx.journal.queuedMessages.get(messageId)
      if (!row) {
        return { ok: true, value: { deleted: false, messageId, disposition: 'missing' } }
      }
      if (row.state === 'dispatched') {
        return { ok: true, value: { deleted: false, messageId, disposition: 'dispatched' } }
      }
      if (row.state === 'withdrawn') {
        return { ok: true, value: { deleted: false, messageId, disposition: 'withdrawn' } }
      }
      // The withdrawal notifies through the journal's commit listener, which
      // also re-derives the drain — deleting a returned card can unblock the
      // drafts behind it.
      const withdrawn = await withdrawQueuedMessagesForOperation(ctx.journal, {
        sessionId: ctx.sessionId,
        messageIds: [messageId],
        callerKey: ctx.resolvedBy,
        operationId
      })
      return withdrawn.length > 0
        ? { ok: true, value: { deleted: true, messageId } }
        : { ok: true, value: { deleted: false, messageId, disposition: 'withdrawn' } }
    },
    replay: (ctx) => {
      const replayed = ctx.journal.queuedMessages
        .receipts(agentSessionOperationKey(ctx.resolvedBy, operationId))
        .some((row) => row.messageId === messageId && row.state === 'withdrawn')
      return replayed ? { deleted: true, messageId } : null
    }
  }
  return mutateQueued(context, caller, params.envelope, plan)
}

/** Resume: ends the queue's pause — a Stop's, or a restart's — so the cards send
 *  again, oldest first, as the session goes idle. A no-op when nothing is paused,
 *  and a per-card hold (`send_failed`, `kept`) stays for its own Send. */
export function resumeStructuredAgentQueue(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope }
): Promise<AgentSessionMutationResult<AgentSessionQueuedMessagesResumeResult>> {
  const plan: MutationPlan<AgentSessionQueuedMessagesResumeResult> = {
    method: 'agentSession.queuedMessagesResume',
    fields: {},
    conversationWrite: true,
    // The Resume row notifies through the journal's commit listener, which publishes the
    // lifted pause and wakes the drain.
    run: async (ctx) => ({
      ok: true,
      value: { resumed: await resumeStructuredQueue(ctx.journal, ctx.fence) }
    }),
    // Like Stop's replay: the Resume already ran, so this one lifts nothing.
    replay: () => ({ resumed: false })
  }
  return mutateQueued(context, caller, params.envelope, plan)
}
