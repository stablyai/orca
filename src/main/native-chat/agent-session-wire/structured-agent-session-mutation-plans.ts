// One plan per mutating method: what it fingerprints, what it does, and how its
// answer is rebuilt on a replay.
//
// The replay half matters more than it looks. The ledger records only that an
// operation happened, so the durable answer has to come back out of the journal.
// A plan that cannot find its effect returns null, and the call runs for real —
// which is exactly right when the crash landed before the journal write.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionOperationOutcome } from '../../../shared/agent-session-operation-ledger'
import type {
  AgentSessionCancelResult,
  AgentSessionMutationEnvelope,
  AgentSessionOptionResult,
  AgentSessionPromptResult,
  AgentSessionSendResult
} from '../../../shared/agent-session-wire'
import {
  performCancel,
  performPrompt,
  performSend,
  performSetOption,
  resumePromptCancellation,
  type AgentSessionTurnContext,
  type TurnOutcome
} from './structured-agent-session-turns'

export type MutationPlan<TValue> = {
  method: string
  fields: Record<string, unknown>
  beforeRun?: () => void
  run: (ctx: AgentSessionTurnContext) => Promise<TurnOutcome<TValue>>
  resume?: (
    ctx: AgentSessionTurnContext,
    outcome: AgentSessionOperationOutcome
  ) => Promise<TurnOutcome<TValue> | null> | TurnOutcome<TValue> | null
  /** A provider-confirmed retry has no provider effect left; settle it under the current host fence. */
  resumeAtCurrentFence?: (outcome: AgentSessionOperationOutcome) => boolean
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
    // A control signal is not payload; only the matching durable unknown unlocks redispatch.
    fields: { body: params.body },
    ...(params.beforeRun ? { beforeRun: params.beforeRun } : {}),
    rerunWhenReplayMissing: (ctx) =>
      params.retryUnknown === true &&
      ctx.journal
        .submissions()
        .some(
          (entry) => entry.clientMessageId === clientMessageId && entry.dispatchState === 'unknown'
        ),
    run: (ctx) =>
      performSend(ctx, {
        clientMessageId,
        payloadFingerprint: params.envelope.payloadFingerprint,
        body: params.body,
        retryUnknown: params.retryUnknown
      }),
    replay: (ctx) => {
      const submission = ctx.journal
        .submissions()
        .find((entry) => entry.clientMessageId === clientMessageId)
      return submission && !(params.retryUnknown && submission.dispatchState === 'unknown')
        ? { clientMessageId, submission }
        : null
    }
  }
}

export function cancelPlan(params: {
  envelope: AgentSessionMutationEnvelope
  turnId?: string
  scope?: 'background-tasks'
  taskId?: string
  prompt?: { itemId: string; expectedRevision: number }
}): MutationPlan<AgentSessionCancelResult> {
  return {
    method: 'agentSession.cancel',
    fields: {
      ...(params.turnId ? { turnId: params.turnId } : {}),
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
    settledOutcome: (value) => ({
      status: 'succeeded',
      sessionId: params.envelope.sessionId,
      cancelled: value.cancelled,
      cancelledTurnId: value.turnId
    }),
    resume: (ctx, outcome) => {
      const settlement = outcome.status === 'unknown' ? outcome.promptCancelSettlement : undefined
      return settlement?.sessionId === params.envelope.sessionId
        ? resumePromptCancellation(ctx, params.envelope.clientOperationId, settlement)
        : null
    },
    resumeAtCurrentFence: (outcome) =>
      outcome.status === 'unknown' &&
      outcome.promptCancelSettlement?.phase === 'provider-confirmed',
    // Interrupting twice would kill a turn the client never asked to stop.
    replay: (_ctx, outcome) =>
      outcome.status === 'succeeded'
        ? {
            turnId: outcome.cancelledTurnId ?? params.turnId ?? params.prompt?.itemId ?? 'unknown',
            cancelled: outcome.cancelled === true
          }
        : null
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
