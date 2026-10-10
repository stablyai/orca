// A Stop that writes no Stop event of its own: a background-task stop, and a prompt card's own
// interrupt. Its target is resolved once and its receipt committed before the provider is asked;
// one that reaches nothing records the no-op it answers, and a card's interrupt that fails once
// saved says on the card's turn that the cancellation was not confirmed.

import { agentChildWorkStopTargets } from '../../../shared/agent-child-work-stop-targets'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionCancelResult } from '../../../shared/agent-session-wire'
import { validatePendingPrompt } from './structured-agent-session-prompt-state'
import { acceptStopTarget } from './structured-agent-session-stop-acceptance'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { noteStructuredAgentSessionStopUnconfirmed } from './structured-agent-session-stop-unconfirmed-note'
import { performCancel } from './structured-agent-session-turns-cancel'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

export async function runTargetedCancel(
  ctx: AgentSessionTurnContext,
  params: {
    clientOperationId: string
    turnId?: string
    scope?: 'background-tasks'
    taskId?: string
    prompt?: { itemId: string; expectedRevision: number }
    childWork?: () => readonly AgentChildWorkView[] | undefined
  }
): Promise<TurnOutcome<AgentSessionCancelResult>> {
  const named = params.turnId !== undefined ? { turnId: params.turnId } : {}
  const { clientOperationId, prompt } = params
  if (params.scope) {
    // Resolved once, here: a retry is answered from the receipt and never reaches a newer task.
    const taskIds = agentChildWorkStopTargets(params.childWork?.(), params.taskId)
    if (taskIds.length === 0) {
      return { ok: true, value: { ...named, cancelled: false } }
    }
    const accepted = await acceptStopTarget(ctx)
    if (!accepted.ok) {
      return accepted
    }
    return performCancel(ctx, { clientOperationId, ...named, scope: params.scope, taskIds })
  }
  // A card already settled is answered as it stands, changing nothing.
  const pending = prompt ? validatePendingPrompt(ctx, prompt) : undefined
  if (!pending || pending.ok) {
    const accepted = await acceptStopTarget(ctx)
    if (!accepted.ok) {
      return accepted
    }
  }
  try {
    return await performCancel(ctx, { clientOperationId, ...named, ...(prompt ? { prompt } : {}) })
  } catch (error) {
    if (ctx.operationReceipt?.isCommitted()) {
      // Saved, so the answer is its receipt; the card's turn says the cancellation went unconfirmed.
      const raised = pending?.ok ? pending.item.turnScope : undefined
      const raisedTurnId =
        raised?.kind === 'turn'
          ? (readAgentJournalTurn(ctx.journal.itemBody(raised.turnItemId) ?? undefined)?.turnId ??
            null)
          : null
      await noteStructuredAgentSessionStopUnconfirmed(
        ctx,
        { turnId: params.turnId ?? raisedTurnId, operationId: clientOperationId },
        error
      )
    }
    throw error
  }
}
