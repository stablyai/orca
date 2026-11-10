import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
// Command receipts prove acceptance; other plans use ledger rows and journal replay.

import { readNoChoiceOptionResult } from '../options/structured-agent-session-option-observation'
import type { AgentChildWorkEvidence } from '../../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import type { AgentChildWorkView } from '../../../../shared/agent-status/child-work/agent-status-child-work-view'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  AGENT_MESSAGE_SOURCE,
  USER_MESSAGE_SOURCE,
  type AgentSessionMessageSource
} from '../../../../shared/agent-session/agent-session-message-source'
import type { AgentSessionOperationOutcome } from '../../../../shared/agent-session/lifecycle/agent-session-operation-ledger'
import type {
  AgentSessionCancelResult,
  AgentSessionMutationEnvelope,
  AgentSessionOptionResult,
  AgentSessionQueuedSendReceipt,
  AgentSessionSendResult
} from '../../../../shared/agent-session/agent-session-wire'
import {
  agentSessionConversationCommandFields,
  type AgentSessionConversationCommandResult
} from '../../../../shared/agent-session/agent-session-conversation-command'
import '../../agent-session-journal/projection/journal-dispatch-doubt-reasons'
import { STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING as DISPATCH_DOUBT_SUBMISSION_MISSING } from '../../../../shared/agent-session/requests/structured-agent-session-send-evidence'
import type { StructuredAgentSessionBackgroundStopInput } from '../termination/structured-agent-session-background-stop'
import {
  agentSessionSendBodyFingerprint,
  agentSessionSendFields,
  type StructuredAgentSessionSendMutation
} from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import {
  STRUCTURED_AGENT_SESSION_COMPACT_COMMAND,
  structuredAgentSessionCompactBody
} from './structured-agent-session-command-turn'
import {
  performSend,
  type AgentSessionTurnContext,
  type AgentSessionReplayContext,
  type TurnOutcome
} from './structured-agent-session-turns'

import { queuedSendAnswer } from '../delivery/structured-agent-session-queued-send-answer'
import { STOP_COMMAND_RECEIPT } from './structured-agent-session-stop-acceptance'
import { runTargetedCancel } from './structured-agent-session-targeted-cancel'
import { journalRowReceiptResult } from './structured-agent-session-journal-row-receipt'

export { journalRowReceiptResult }
import type { JournalOperationReceipt } from '../../agent-session-journal/writing/journal-row-writer'
import type { CommandReceiptResult } from '../../agent-session-journal/writing/command-receipt-schema'
import type { JournalRow } from '../../agent-session-journal/durable-rows/journal-row-schema'

export type MutationPlan<TValue> = {
  method: string
  fields: Record<string, unknown>
  operationIdScope?: 'global'
  acceptanceRecord?: (record: AgentSessionRecord) => AgentSessionRecord
  /** Needs no writer lease. */
  conversationWrite?: true
  run: (ctx: AgentSessionTurnContext) => Promise<TurnOutcome<TValue>>
  /** receipt is the accepted command receipt result, when declared. */
  replay: (
    ctx: AgentSessionReplayContext,
    outcome: AgentSessionOperationOutcome,
    receipt?: CommandReceiptResult
  ) => TValue | null
  rerunWhenReplayMissing?: (ctx: AgentSessionReplayContext) => boolean
  recoverUnknownFromDurableState?: boolean
} & (
  | {
      commandReceipt: MutationCommandReceipt<TValue>
      settlesWithWrite?: never
      successReceipt?: never
      settledOutcome?: never
    }
  | {
      /** Success commits with the effect; absent receipts require fallback settlement. */
      settlesWithWrite: true
      commandReceipt?: never
      successReceipt?: () => JournalOperationReceipt
      settledOutcome?: (value: TValue) => AgentSessionOperationOutcome
    }
  | {
      settlesWithWrite?: never
      commandReceipt?: never
      settledOutcome?: (value: TValue) => AgentSessionOperationOutcome
    }
)

/** Insert acceptance with its effect, if absent. */
export type MutationCommandReceipt<TValue> = {
  /** Resolve inside the effect transaction; draft writes have no journal row. */
  result: (row: JournalRow | undefined) => CommandReceiptResult
  /** Commit a standalone receipt before answering a row-free result; null records nothing. */
  unwritten?: (value: TValue, ctx: AgentSessionTurnContext) => CommandReceiptResult | null
}

function submissionOrDraftReceipt<TValue>(clientMessageId: string): MutationCommandReceipt<TValue> {
  return {
    result: (row) =>
      row
        ? journalRowReceiptResult(row, 'submission')
        : { kind: 'queued-draft', messageId: clientMessageId }
  }
}

function sendSource(params: {
  body: AgentJournalMessageItem
  userSend?: true
  personsMessage?: true
}): AgentSessionMessageSource | undefined {
  if (params.userSend || params.personsMessage) {
    return USER_MESSAGE_SOURCE
  }
  return params.body.from ? AGENT_MESSAGE_SOURCE : undefined
}

export function sendPlan(
  params: StructuredAgentSessionSendMutation & {
    retryUnknown?: true
    userSend?: true
    /** Host-sent personal text; userSend always implies this. */
    personsMessage?: true
    beforeRun?: () => void
  }
): MutationPlan<AgentSessionSendResult> {
  // Match operation ID to optimistic client message ID for durable reconciliation.
  const clientMessageId = params.envelope.clientOperationId
  return {
    method: 'agentSession.send',
    operationIdScope: 'global',
    conversationWrite: true,
    commandReceipt: submissionOrDraftReceipt(clientMessageId),
    // Control fields affect operation identity; submission echo matching hashes only the body.
    fields: agentSessionSendFields(params),
    recoverUnknownFromDurableState: true,
    // retryUnknown is compatibility-only; recorded sends replay without redelivery.
    run: async (ctx) => {
      const source = sendSource(params)
      return performSend(ctx, {
        origin: params.userSend ? 'client' : 'host',
        ...(source ? { source } : {}),
        clientMessageId,
        ...(params.steer ? { steer: params.steer } : {}),
        ...(params.options ? { options: params.options } : {}),
        ...(params.selection !== undefined ? { selection: params.selection } : {}),
        // Body-only, so the reducer's echo aliasing never sees control fields or the sender.
        payloadFingerprint: agentSessionSendBodyFingerprint(params.envelope.sessionId, params.body),
        body: params.body
      })
    },
    replay: (ctx, outcome) => {
      const queued = queuedSendAnswer(ctx.journal, clientMessageId)
      if (queued) {
        return queued
      }
      const submission = ctx.journal.submission(clientMessageId)
      if (submission) {
        return { clientMessageId, submission: { ...submission } }
      }
      // Pending/failed rows with no effect run fresh; succeeded rows may be dropped by new epochs.
      if (outcome.status === 'failed' || outcome.status === 'pending') {
        return null
      }
      const resolvedAt = ctx.now()
      return {
        clientMessageId,
        submission: {
          clientMessageId,
          fence: ctx.fence,
          payloadFingerprint: params.envelope.payloadFingerprint,
          dispatchState: 'unknown',
          providerItemId: null,
          reason: DISPATCH_DOUBT_SUBMISSION_MISSING,
          submittedAt: resolvedAt,
          resolvedAt,
          recovered: true
        }
      }
    }
  }
}

export type ConversationCommandAcceptance =
  | { clientMessageId: string }
  | { queued: AgentSessionQueuedSendReceipt }
  /** Legacy command result. */
  | { recorded: AgentSessionConversationCommandResult }

/** Accept compact as a submission, or as a queued card later converted to one. */
export function conversationCommandPlan(params: {
  envelope: AgentSessionMutationEnvelope
  instructions?: string
  delivery?: 'queue-if-active'
  priorRecord: () => AgentSessionConversationCommandResult | null
}): MutationPlan<ConversationCommandAcceptance> {
  const clientMessageId = params.envelope.clientOperationId
  return {
    method: 'agentSession.conversationCommand',
    operationIdScope: 'global',
    conversationWrite: true,
    commandReceipt: submissionOrDraftReceipt(clientMessageId),
    fields: agentSessionConversationCommandFields(STRUCTURED_AGENT_SESSION_COMPACT_COMMAND, params),
    recoverUnknownFromDurableState: true,
    run: async (ctx) => {
      const sent = await performSend(ctx, {
        clientMessageId,
        origin: 'client',
        source: USER_MESSAGE_SOURCE,
        payloadFingerprint: params.envelope.payloadFingerprint,
        body: structuredAgentSessionCompactBody(params.instructions)
      })
      return sent.ok ? { ok: true, value: { clientMessageId } } : sent
    },
    replay: (ctx) => {
      const queued = queuedSendAnswer(ctx.journal, clientMessageId)
      if (queued) {
        return 'queued' in queued
          ? { queued: queued.queued }
          : { clientMessageId: queued.submission.clientMessageId }
      }
      if (ctx.journal.submission(clientMessageId) !== undefined) {
        return { clientMessageId }
      }
      const prior = params.priorRecord()
      return prior ? { recorded: prior } : null
    }
  }
}

export function cancelPlan(params: {
  envelope: AgentSessionMutationEnvelope
  turnId?: string
  scope?: 'background-tasks'
  taskId?: string
  prompt?: { itemId: string; expectedRevision: number }
  childWork?: () => readonly AgentChildWorkView[] | undefined
  acknowledgeStops?: (evidence: AgentChildWorkEvidence[]) => void
  captureStops?: StructuredAgentSessionBackgroundStopInput['captureStops']
  unlisted?: StructuredAgentSessionBackgroundStopInput['unlisted']
}): MutationPlan<AgentSessionCancelResult> {
  const named = params.turnId !== undefined ? { turnId: params.turnId } : {}
  return {
    method: 'agentSession.cancel',
    // Chat Stop needs only conversation access; background/prompt cancels need the live child.
    ...(params.scope || params.prompt ? {} : { conversationWrite: true as const }),
    // Commit before acting; failed acceptance must interrupt nothing.
    commandReceipt: STOP_COMMAND_RECEIPT,
    fields: {
      ...named,
      ...(params.scope ? { scope: params.scope } : {}),
      ...(params.taskId ? { taskId: params.taskId } : {}),
      ...(params.prompt ? { prompt: params.prompt } : {})
    },
    // Chat Stop uses mutateWithChatStop; this path handles targeted and prompt interrupts.
    run: (ctx) =>
      runTargetedCancel(ctx, { ...params, clientOperationId: params.envelope.clientOperationId }),
    // Retry must not interrupt again and accidentally cut a later turn.
    replay: () => ({ ...named, cancelled: false })
  }
}

export function setOptionPlan(params: { key: string; value: string }) {
  return {
    method: 'agentSession.setOption',
    fields: { key: params.key, value: params.value },
    run: async (ctx) => {
      const options = { ...ctx.persistedOptions, [params.key]: params.value }
      await ctx.persistOptions(options)
      ctx.publish()
      return { ok: true, value: { ...params, options } }
    },
    // Reapply unsettled picks; only a settled success can be replayed directly.
    replay: (ctx, outcome) => {
      if (outcome.status !== 'succeeded') {
        return null
      }
      if (Object.hasOwn(outcome, 'optionResult')) {
        return readNoChoiceOptionResult(outcome.optionResult, params)
      }
      return {
        key: params.key,
        value: params.value,
        ...(ctx.persistedOptions ? { options: { ...ctx.persistedOptions } } : {})
      }
    }
  } satisfies MutationPlan<AgentSessionOptionResult>
}
