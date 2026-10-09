// A Stop that writes no Stop event of its own: a background-task stop, and a prompt card's own
// interrupt. Its target is captured and its receipt committed before the provider is asked; one
// that reaches nothing records the no-op it answers.

import { agentChildWorkStopTargets } from '../../../shared/agent-child-work-stop-targets'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionCancelResult } from '../../../shared/agent-session-wire'
import { validatePendingPrompt } from './structured-agent-session-prompt-state'
import {
  acceptStopTarget,
  type StructuredAgentSessionStopAcceptance
} from './structured-agent-session-stop-acceptance'
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
  },
  acceptance: StructuredAgentSessionStopAcceptance
): Promise<TurnOutcome<AgentSessionCancelResult>> {
  const named = params.turnId !== undefined ? { turnId: params.turnId } : {}
  const { clientOperationId, prompt } = params
  if (params.scope) {
    // Resolved once, here: a retry is answered from the receipt and never reaches a newer task.
    const taskIds = agentChildWorkStopTargets(params.childWork?.(), params.taskId)
    if (taskIds.length === 0) {
      return { ok: true, value: { ...named, cancelled: false } }
    }
    const accepted = await acceptStopTarget(ctx, acceptance, { ...named, taskIds })
    if (!accepted.ok) {
      return accepted
    }
    return performCancel(ctx, { clientOperationId, ...named, scope: params.scope, taskIds })
  }
  // A card already settled is answered as it stands, changing nothing.
  if (!prompt || validatePendingPrompt(ctx, prompt).ok) {
    const accepted = await acceptStopTarget(ctx, acceptance, {
      ...named,
      ...(prompt ? { prompt: { itemId: prompt.itemId, revision: prompt.expectedRevision } } : {})
    })
    if (!accepted.ok) {
      return accepted
    }
  }
  return performCancel(ctx, { clientOperationId, ...named, ...(prompt ? { prompt } : {}) })
}
