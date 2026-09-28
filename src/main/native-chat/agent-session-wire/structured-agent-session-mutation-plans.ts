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
import { DISPATCH_DOUBT_SUBMISSION_MISSING } from '../agent-session-journal/journal-dispatch-doubt-reasons'
import {
  performCancel,
  performPrompt,
  performSend,
  performSetOption,
  type AgentSessionTurnContext,
  type TurnOutcome
} from './structured-agent-session-turns'
import type { AgentSessionPromptRequest } from './structured-agent-session-turns-prompt'

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

export function promptPlan(
  params: AgentSessionPromptRequest
): MutationPlan<AgentSessionPromptResult> {
  return {
    method: `agentSession.respondTo:${params.kind}`,
    // The client hashes exactly what it sent; the absent one of these two drops out of the digest.
    fields: {
      itemId: params.itemId,
      expectedRevision: params.expectedRevision,
      optionId: params.optionId,
      answers: params.answers
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
