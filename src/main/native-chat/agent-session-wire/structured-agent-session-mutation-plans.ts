// One plan per mutating method: what it fingerprints, what it does, and how its
// answer is rebuilt on a replay.
//
// The replay half matters more than it looks. The ledger records only that an
// operation happened, so the durable answer usually comes back out of the
// journal. Send is fail-closed: admission alone cannot prove non-delivery.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionOperationOutcome } from '../../../shared/agent-session-operation-ledger'
import type {
  AgentSessionCancelResult,
  AgentSessionMutationEnvelope,
  AgentSessionOptionResult,
  AgentSessionPromptResult,
  AgentSessionSendResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionConversationCommandResult } from '../../../shared/agent-session-conversation-command'
import { DISPATCH_DOUBT_SUBMISSION_MISSING } from '../agent-session-journal/journal-dispatch-doubt-reasons'
import {
  STRUCTURED_AGENT_SESSION_COMPACT_COMMAND,
  structuredAgentSessionCompactBody
} from './structured-agent-session-command-turn'
import {
  performCancel,
  performPrompt,
  performSend,
  performSetOption,
  type AgentSessionTurnContext,
  type TurnOutcome
} from './structured-agent-session-turns'

export type MutationPlan<TValue> = {
  method: string
  fields: Record<string, unknown>
  operationIdScope?: 'global'
  /** Admitted without the writer lease: see `admitAgentSessionMutation`. */
  conversationWrite?: true
  markUnknownBeforeRun?: boolean
  run: (ctx: AgentSessionTurnContext) => Promise<TurnOutcome<TValue>>
  replay: (ctx: AgentSessionTurnContext, outcome: AgentSessionOperationOutcome) => TValue | null
  rerunWhenReplayMissing?: (ctx: AgentSessionTurnContext) => boolean
  recoverUnknownFromDurableState?: boolean
  settledOutcome?: (value: TValue) => AgentSessionOperationOutcome
}

export function sendPlan(params: {
  envelope: AgentSessionMutationEnvelope
  body: AgentJournalMessageItem
  retryUnknown?: true
  beforeRun?: () => void
}): MutationPlan<AgentSessionSendResult> {
  // The operation id IS the client message id: one send, one durable row, one
  // key the client reconciles its optimistic bubble against.
  const clientMessageId = params.envelope.clientOperationId
  return {
    method: 'agentSession.send',
    operationIdScope: 'global',
    conversationWrite: true,
    markUnknownBeforeRun: true,
    // A control signal is not payload; it cannot alter durable replay.
    fields: { body: params.body },
    recoverUnknownFromDurableState: true,
    // `retryUnknown` is a compatibility-only client signal. A recorded send
    // always replays and never reaches the provider twice.
    run: (ctx) => {
      // Asked at acceptance: a send accepted after this one is queued behind it.
      params.beforeRun?.()
      return performSend(ctx, {
        clientMessageId,
        payloadFingerprint: params.envelope.payloadFingerprint,
        body: params.body
      })
    },
    replay: (ctx, outcome) => {
      const submission = ctx.journal
        .submissions()
        .find((entry) => entry.clientMessageId === clientMessageId)
      if (submission) {
        return { clientMessageId, submission }
      }
      if (outcome.status === 'failed') {
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
  /** What an older build's run of this operation recorded. */
  | { recorded: AgentSessionConversationCommandResult }

/** `/compact` accepted like a send: one submission, keyed by the operation id, that the delivery
 *  loop carries out as the command's own turn. */
export function conversationCommandPlan(params: {
  envelope: AgentSessionMutationEnvelope
  priorRecord: () => AgentSessionConversationCommandResult | null
}): MutationPlan<ConversationCommandAcceptance> {
  const clientMessageId = params.envelope.clientOperationId
  return {
    method: 'agentSession.conversationCommand',
    conversationWrite: true,
    markUnknownBeforeRun: true,
    fields: { command: STRUCTURED_AGENT_SESSION_COMPACT_COMMAND },
    recoverUnknownFromDurableState: true,
    run: async (ctx) => {
      const sent = await performSend(ctx, {
        clientMessageId,
        payloadFingerprint: params.envelope.payloadFingerprint,
        body: structuredAgentSessionCompactBody()
      })
      return sent.ok ? { ok: true, value: { clientMessageId } } : sent
    },
    replay: (ctx, outcome) => {
      if (outcome.status === 'succeeded' && outcome.conversationCommand) {
        return { recorded: outcome.conversationCommand }
      }
      if (ctx.journal.submissions().some((entry) => entry.clientMessageId === clientMessageId)) {
        return { clientMessageId }
      }
      const prior = params.priorRecord()
      return prior ? { recorded: prior } : null
    }
  }
}

export function cancelPlan(params: {
  envelope: AgentSessionMutationEnvelope
  turnId: string
  scope?: 'background-tasks'
  taskId?: string
  prompt?: { itemId: string; expectedRevision: number }
}): MutationPlan<AgentSessionCancelResult> {
  return {
    method: 'agentSession.cancel',
    // Stop is a conversation write; a prompt or background-task cancel needs the live child.
    ...(params.scope || params.prompt ? {} : { conversationWrite: true as const }),
    fields: {
      turnId: params.turnId,
      ...(params.scope ? { scope: params.scope } : {}),
      ...(params.taskId ? { taskId: params.taskId } : {}),
      ...(params.prompt ? { prompt: params.prompt } : {})
    },
    run: (ctx) =>
      performCancel(ctx, {
        clientOperationId: params.envelope.clientOperationId,
        turnId: params.turnId,
        ...(params.scope ? { scope: params.scope } : {}),
        ...(params.taskId ? { taskId: params.taskId } : {}),
        ...(params.prompt ? { prompt: params.prompt } : {})
      }),
    // Interrupting twice would kill a turn the client never asked to stop, so a
    // replay reports the turn as already handled instead.
    replay: () => ({ turnId: params.turnId, cancelled: false })
  }
}

export function promptPlan(params: {
  kind: 'approval' | 'question'
  itemId: string
  expectedRevision: number
  optionId: string
}): MutationPlan<AgentSessionPromptResult> {
  return {
    method: `agentSession.respondTo:${params.kind}`,
    fields: {
      itemId: params.itemId,
      expectedRevision: params.expectedRevision,
      optionId: params.optionId
    },
    run: (ctx) => performPrompt(ctx, params),
    replay: (ctx) => {
      const item = ctx.journal.snapshot().items.find((entry) => entry.itemId === params.itemId)
      const body = item?.body
      if (!item || !body || (body.kind !== 'approval' && body.kind !== 'question')) {
        return null
      }
      return body.resolution.state === 'pending'
        ? null
        : { itemId: item.itemId, revision: item.revision, resolution: body.resolution }
    }
  }
}

export function setOptionPlan(params: {
  key: string
  value: string
}): MutationPlan<AgentSessionOptionResult> {
  return {
    method: 'agentSession.setOption',
    fields: { key: params.key, value: params.value },
    run: (ctx) => performSetOption(ctx, params),
    // A pending row may have crashed before the adapter call. Reapplying the
    // same assignment is safe; only a settled success can be answered directly.
    replay: (ctx, outcome) =>
      outcome.status === 'succeeded'
        ? {
            key: params.key,
            value: params.value,
            ...(ctx.persistedOptions ? { options: { ...ctx.persistedOptions } } : {})
          }
        : null
  }
}
