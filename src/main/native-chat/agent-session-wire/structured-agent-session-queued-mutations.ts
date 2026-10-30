// Commit action receipts with effects so lost replies replay without ledger admission.
// Published cards own rendered text; mutation answers carry none.

import { contextStructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionQueuedMessageDeleteResult,
  AgentSessionQueuedMessagesResumeResult,
  AgentSessionSendResult
} from '../../../shared/agent-session-wire'
import { QueuedMessageNotConsumableError } from '../agent-session-journal/queued-message-consume-error'
import { refusingNewerOrcaJournal } from '../agent-session-journal/journal-open-failure'
import {
  journalRowReceiptResult,
  type MutationPlan
} from './structured-agent-session-mutation-plans'
import type { CommandReceiptResult } from '../agent-session-journal/command-receipt-schema'
import { structuredQueueHold } from './structured-agent-session-queued-messages'
import { resumeStructuredQueue } from './structured-agent-session-queued-pause'
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

function submissionRowReceipt(
  ctx: AgentSessionTurnContext,
  submission: AgentJournalSubmission | undefined
): CommandReceiptResult {
  if (submission?.submittedSequence === undefined) {
    throw new Error('an acknowledged hand-off requires its submission row')
  }
  return { kind: 'journal-row', epoch: ctx.journal.epoch, sequence: submission.submittedSequence }
}

export function mutateQueued<TValue>(
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

/** Override FIFO/hold/working policy only, never send/prompt safety gates; link via queuedMessageId. */
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
    commandReceipt: {
      result: (row) => journalRowReceiptResult(row, 'submission'),
      unwritten: (value, ctx) =>
        submissionRowReceipt(ctx, 'submission' in value ? value.submission : undefined)
    },
    run: async (ctx): Promise<TurnOutcome<AgentSessionSendResult>> => {
      // Send-now overrides working/FIFO/stored holds, preserving stronger gates.
      const record = context.deps.store.getRecord(ctx.sessionId)
      const work = contextStructuredAgentSessionCurrentWork(ctx)
      const hold = structuredQueueHold({ record, work })
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
        const submission = row.consumedAs === null ? undefined : submissionFor(ctx, row.consumedAs)
        return submission
          ? { ok: true, value: { clientMessageId: submission.clientMessageId, submission } }
          : invalid('This queued message was already sent.')
      }
      // Commands cannot steer; enforce idle-only Send even for older clients.
      if (row.body.command && work.working()) {
        return invalid("A command can't be sent while the agent is working.")
      }
      const submissionId = operationId
      try {
        await ctx.journal.appendSubmission(
          {
            clientMessageId: submissionId,
            // Personal handoffs return as cards on close/restart.
            origin: 'client',
            humanRelease: true,
            ...(row.body.from ? { source: { kind: 'agent' } } : { source: { kind: 'user' } }),
            payloadFingerprint: row.fingerprint,
            body: row.body,
            ...(row.options ? { options: row.options } : {}),
            fence: ctx.fence,
            handoverRecorded: true
          },
          { messageId, expect: row.state },
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
    // Replay the receipt’s original handoff, never the card’s newer handoff.
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

/** Discard with no text in the reply; published removal is the client’s outcome. */
export function deleteQueuedStructuredAgentMessage(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope; messageId: string }
): Promise<AgentSessionMutationResult<AgentSessionQueuedMessageDeleteResult>> {
  const { messageId } = params
  const plan: MutationPlan<AgentSessionQueuedMessageDeleteResult> = {
    method: 'agentSession.queuedMessageDelete',
    fields: { messageId },
    conversationWrite: true,
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
      // Withdrawal commits wake delivery; removing a returned head can unblock later cards.
      const withdrawn = await ctx.journal.queuedMessages.withdraw([messageId], ctx.operationReceipt)
      return withdrawn.length > 0
        ? { ok: true, value: { deleted: true, messageId } }
        : { ok: true, value: { deleted: false, messageId, disposition: 'withdrawn' } }
    },
    // Receipt survives tombstone pruning.
    replay: (_ctx, _outcome, receipt) => {
      if (receipt?.kind === 'no-op' && receipt.outcome.kind === 'queue-delete') {
        return { deleted: false, messageId, disposition: receipt.outcome.disposition }
      }
      return receipt?.kind === 'queued-draft' ? { deleted: true, messageId } : null
    }
  }
  return mutateQueued(context, caller, params.envelope, plan)
}

/** Lift queue pauses, preserving per-card holds for explicit Send; no-op when unpaused. */
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
    run: async (ctx) => ({
      ok: true,
      value: {
        resumed: await resumeStructuredQueue(ctx.journal, ctx.fence, ctx.operationReceipt)
      }
    }),
    // Replay must not lift a newer pause.
    replay: () => ({ resumed: false })
  }
  return mutateQueued(context, caller, params.envelope, plan)
}
