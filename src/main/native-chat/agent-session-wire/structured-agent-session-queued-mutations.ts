// `agentSession.queuedMessageSend` / `agentSession.queuedMessageDelete` / Resume: mutations of
// the conversation's queued drafts. Each action's command receipt commits with the row it
// changes, so a lost acknowledgement replays from that receipt and the rows it points at, never
// from the operation ledger. No mutation returns draft text:
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
import {
  journalRowReceiptResult,
  type MutationPlan
} from './structured-agent-session-mutation-plans'
import type { JournalOperationReceipt } from '../agent-session-journal/journal-row-writer'
import type { CommandReceiptResult } from '../agent-session-journal/command-receipt-schema'
import { structuredQueueHold } from './structured-agent-session-queued-messages'
import {
  resumeStructuredQueue,
  structuredAgentSessionHostInstance
} from './structured-agent-session-queued-pause'
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

/** Where the journal wrote a hand-off's submission, so a replay answers with that one. */
function submissionRowReceipt(
  ctx: AgentSessionTurnContext,
  submission: AgentJournalSubmission | undefined
): CommandReceiptResult {
  if (submission?.submittedSequence === undefined) {
    throw new Error('an acknowledged hand-off requires its submission row')
  }
  return { kind: 'journal-row', epoch: ctx.journal.epoch, sequence: submission.submittedSequence }
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
  },
  receipt?: JournalOperationReceipt
): Promise<QueuedMessageRow[]> {
  return journal.queuedMessages.withdraw(
    {
      messageIds: input.messageIds,
      settledByOp: agentSessionOperationKey(input.callerKey, input.operationId)
    },
    receipt
  )
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
    // Its own submission's row, or the row of the hand-off that already took the card.
    commandReceipt: {
      result: (row) => journalRowReceiptResult(row, 'submission'),
      unwritten: (value, ctx) =>
        submissionRowReceipt(ctx, 'submission' in value ? value.submission : undefined)
    },
    run: async (ctx): Promise<TurnOutcome<AgentSessionSendResult>> => {
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
          },
          ctx.operationReceipt
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
      return { ok: true, value: { clientMessageId: submissionId, submission } }
    },
    // The hand-off the receipt points at, never whichever one the card holds now.
    replay: (ctx, _outcome, receipt) => {
      const submission =
        receipt?.kind === 'journal-row' && receipt.epoch === ctx.journal.epoch
          ? ctx.journal.submissions().find((entry) => entry.submittedSequence === receipt.sequence)
          : undefined
      return submission?.queuedMessageId === messageId
        ? { clientMessageId: submission.clientMessageId, submission }
        : null
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
    // The withdrawn card, or a no-op's answer when there was nothing left to withdraw.
    commandReceipt: {
      result: () => ({ kind: 'queued-draft', messageId }),
      unwritten: (value) =>
        value.deleted
          ? null
          : {
              kind: 'no-op',
              outcome: { kind: 'queue-delete', messageId, disposition: value.disposition }
            }
    },
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
      const withdrawn = await withdrawQueuedMessagesForOperation(
        ctx.journal,
        {
          sessionId: ctx.sessionId,
          messageIds: [messageId],
          callerKey: ctx.resolvedBy,
          operationId
        },
        ctx.operationReceipt
      )
      return withdrawn.length > 0
        ? { ok: true, value: { deleted: true, messageId } }
        : { ok: true, value: { deleted: false, messageId, disposition: 'withdrawn' } }
    },
    // The receipt alone answers, so a pruned tombstone cannot lose it.
    replay: (_ctx, _outcome, receipt) => {
      if (receipt?.kind === 'no-op' && receipt.outcome.kind === 'queue-delete') {
        return { deleted: false, messageId, disposition: receipt.outcome.disposition }
      }
      return receipt?.kind === 'queued-draft' ? { deleted: true, messageId } : null
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
    commandReceipt: {
      result: (row) => journalRowReceiptResult(row, 'tombstone'),
      unwritten: () => ({ kind: 'no-op', outcome: { kind: 'queue-resume', resumed: false } })
    },
    // The Resume row notifies through the journal's commit listener, which publishes the
    // lifted pause and wakes the drain.
    run: async (ctx) => ({
      ok: true,
      value: {
        resumed: await resumeStructuredQueue(ctx.journal, ctx.fence, ctx.operationReceipt)
      }
    }),
    // Like Stop's replay: the Resume already ran, so this one lifts nothing.
    replay: () => ({ resumed: false })
  }
  return mutateQueued(context, caller, params.envelope, plan)
}
