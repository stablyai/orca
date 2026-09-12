import {
  isBoundedAgentSessionOperationProviderId,
  type AgentSessionPromptCancelSettlement
} from '../../../shared/agent-session-operation-ledger'
import type {
  AgentSessionCancelResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { preparePromptCancellation } from './structured-agent-session-prompt-cancellation'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

export class AgentSessionPreEffectPersistenceError extends Error {
  constructor(readonly original: unknown) {
    super('agent_session_pre_effect_persistence_failed')
  }
}

function invalid(message: string): { ok: false; refusal: AgentSessionWireRefusal } {
  return { ok: false, refusal: { code: 'agent_session_operation_invalid', message } }
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

export async function performCancel(
  ctx: AgentSessionTurnContext,
  input: {
    clientOperationId: string
    turnId?: string
    scope?: 'background-tasks'
    taskId?: string
    prompt?: { itemId: string; expectedRevision: number }
  }
): Promise<TurnOutcome<AgentSessionCancelResult>> {
  const promptCancellation =
    input.prompt && !input.scope ? await preparePromptCancellation(ctx, input.prompt) : null
  if (promptCancellation && !promptCancellation.ok) {
    return promptCancellation
  }
  const turnId = promptCancellation?.ok ? promptCancellation.turnId : input.turnId
  if (!turnId) {
    return invalid('Cancellation requires a turn or pending prompt.')
  }
  if (
    !isBoundedAgentSessionOperationProviderId(turnId) ||
    (promptCancellation?.ok &&
      promptCancellation.threadId !== undefined &&
      !isBoundedAgentSessionOperationProviderId(promptCancellation.threadId))
  ) {
    return invalid('The provider turn identity is too large to cancel durably.')
  }
  const settlement =
    promptCancellation?.ok && input.prompt
      ? {
          phase: 'prepared' as const,
          sessionId: ctx.sessionId,
          runtimeFence: ctx.fence,
          ...(promptCancellation.threadId ? { threadId: promptCancellation.threadId } : {}),
          turnId,
          target: input.prompt,
          prompts: promptCancellation.prompts,
          resolvedAt: ctx.now()
        }
      : null
  if (settlement) {
    try {
      await ctx.persistOperationOutcome(input.clientOperationId, {
        status: 'unknown',
        promptCancelSettlement: settlement
      })
    } catch (error) {
      throw new AgentSessionPreEffectPersistenceError(error)
    }
  }
  let cancelled = false
  let note = 'Cancellation requested.'
  try {
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
            ...(promptCancellation?.ok && promptCancellation.threadId
              ? { threadId: promptCancellation.threadId }
              : {}),
            turnId,
            fence: ctx.fence,
            ...(input.prompt
              ? {
                  promptItemId: input.prompt.itemId,
                  promptCancellationId: promptCancellationSettlementId(input.clientOperationId),
                  promptCancellationResolvedBy: ctx.resolvedBy,
                  promptCancellationResolvedAt: settlement?.resolvedAt
                }
              : {})
          })
        ).cancelled
    if (!cancelled) {
      note = 'The provider had already finished this turn.'
    }
  } catch (error) {
    note = `Cancellation was not confirmed: ${
      error instanceof Error ? error.message : String(error)
    }`
    if (settlement) {
      throw error
    }
  }
  if (input.scope) {
    return { ok: true, value: { turnId, cancelled } }
  }
  if (cancelled && settlement) {
    await ctx.flushLifecycle()
    const confirmed = { ...settlement, phase: 'provider-confirmed' as const }
    await ctx.persistOperationOutcome(input.clientOperationId, {
      status: 'unknown',
      promptCancelSettlement: confirmed
    })
    return settlePromptCancellation(ctx, input.clientOperationId, confirmed)
  }
  await appendStatus(ctx, input.clientOperationId, note)
  return { ok: true, value: { turnId, cancelled } }
}

async function settlePromptCancellation(
  ctx: AgentSessionTurnContext,
  clientOperationId: string,
  settlement: AgentSessionPromptCancelSettlement
): Promise<TurnOutcome<AgentSessionCancelResult>> {
  const settled = await ctx.journal.cancelPromptsAtRevisions({
    prompts: settlement.prompts,
    settlementId: promptCancellationSettlementId(clientOperationId),
    resolvedBy: ctx.resolvedBy,
    resolvedAt: settlement.resolvedAt,
    fence: ctx.fence
  })
  if (settled > 0) {
    ctx.publish()
  }
  await appendStatus(ctx, clientOperationId, 'Cancellation requested.')
  return { ok: true, value: { turnId: settlement.turnId, cancelled: true } }
}

export async function resumePromptCancellation(
  ctx: AgentSessionTurnContext,
  clientOperationId: string,
  settlement: AgentSessionPromptCancelSettlement
): Promise<TurnOutcome<AgentSessionCancelResult> | null> {
  if (settlement.phase === 'provider-confirmed') {
    return settlePromptCancellation(ctx, clientOperationId, settlement)
  }
  await ctx.flushLifecycle()
  let displayed = await ctx.journal.readItem(settlement.target.itemId)
  if (hasPromptCancellationProof(displayed, clientOperationId)) {
    return settlePromptCancellation(ctx, clientOperationId, settlement)
  }
  if (settlement.runtimeFence !== ctx.fence) {
    return null
  }
  if (
    !displayed ||
    (displayed.body.kind !== 'approval' && displayed.body.kind !== 'question') ||
    displayed.body.resolution.state !== 'pending' ||
    displayed.revision !== settlement.target.expectedRevision
  ) {
    return null
  }
  const prepared = await preparePromptCancellation(ctx, settlement.target)
  if (
    !prepared.ok ||
    prepared.turnId !== settlement.turnId ||
    prepared.threadId !== settlement.threadId
  ) {
    await ctx.flushLifecycle()
    displayed = await ctx.journal.readItem(settlement.target.itemId)
    if (hasPromptCancellationProof(displayed, clientOperationId)) {
      return settlePromptCancellation(ctx, clientOperationId, settlement)
    }
    return null
  }
  const result = await ctx.adapter.cancelTurn({
    sessionId: ctx.sessionId,
    ...(prepared.threadId ? { threadId: prepared.threadId } : {}),
    turnId: prepared.turnId,
    fence: ctx.fence,
    promptItemId: settlement.target.itemId,
    promptCancellationId: promptCancellationSettlementId(clientOperationId),
    promptCancellationResolvedBy: ctx.resolvedBy,
    promptCancellationResolvedAt: settlement.resolvedAt
  })
  if (!result.cancelled) {
    await ctx.flushLifecycle()
    displayed = await ctx.journal.readItem(settlement.target.itemId)
    if (hasPromptCancellationProof(displayed, clientOperationId)) {
      return settlePromptCancellation(ctx, clientOperationId, settlement)
    }
    return { ok: true, value: { turnId: settlement.turnId, cancelled: false } }
  }
  await ctx.flushLifecycle()
  const confirmed: AgentSessionPromptCancelSettlement = {
    ...settlement,
    phase: 'provider-confirmed',
    prompts: prepared.prompts
  }
  await ctx.persistOperationOutcome(clientOperationId, {
    status: 'unknown',
    promptCancelSettlement: confirmed
  })
  return settlePromptCancellation(ctx, clientOperationId, confirmed)
}

function promptCancellationSettlementId(clientOperationId: string): string {
  return `prompt-cancel:${clientOperationId}`
}

function hasPromptCancellationProof(
  displayed: Awaited<ReturnType<AgentSessionJournal['readItem']>>,
  clientOperationId: string
): boolean {
  return Boolean(
    displayed &&
    (displayed.body.kind === 'approval' || displayed.body.kind === 'question') &&
    displayed.body.resolution.state === 'cancelled' &&
    displayed.body.resolution.settlementId === promptCancellationSettlementId(clientOperationId)
  )
}
