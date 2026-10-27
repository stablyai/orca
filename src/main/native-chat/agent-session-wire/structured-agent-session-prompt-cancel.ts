// Route Cancel on the host for consistent clients; absent provider routing interrupts the card’s turn.

import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { refuse, type AgentSessionCancelResult } from '../../../shared/agent-session-wire'
import { AgentSessionPromptUnavailableError } from './structured-agent-session-adapter'
import type { StructuredAgentSessionChatStopRun } from './structured-agent-session-chat-stop'
import {
  answerCancelOfSettledPrompt,
  isEndedGenerationPrompt,
  validatePendingPrompt,
  type PendingPromptValidation
} from './structured-agent-session-prompt-state'
import { cardCancelNotSavedRefusal, stopNotSaved } from './structured-agent-session-stop-acceptance'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'
import { contextStructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'

type CancelOutcome = TurnOutcome<AgentSessionCancelResult>
type PendingPrompt = Extract<PendingPromptValidation, { ok: true }>

export async function cancelStructuredAgentSessionPrompt(
  ctx: AgentSessionTurnContext,
  input: { turnId?: string; prompt: { itemId: string; expectedRevision: number } },
  routes: {
    stop: () => Promise<StructuredAgentSessionChatStopRun>
    interrupt: () => Promise<CancelOutcome>
  }
): Promise<CancelOutcome> {
  const validated = validatePendingPrompt(ctx, input.prompt)
  if (!validated.ok) {
    return answerCancelOfSettledPrompt(ctx, input, validated)
  }
  const route = ctx.adapter.routePromptCancel?.({
    sessionId: ctx.sessionId,
    prompt: validated.prompt
  })
  if (isEndedGenerationPrompt(ctx, validated)) {
    return cancelEndedGenerationPrompt(ctx, input, validated, route ? null : routes.interrupt)
  }
  if (!route) {
    return routes.interrupt()
  }
  const cancelled: CancelOutcome = {
    ok: true,
    value: { ...(input.turnId ? { turnId: input.turnId } : {}), cancelled: true }
  }
  // Recheck after handover: dismiss stale/background prompts without stopping an unrelated live turn.
  // Save dismissal with the receipt unless Stop already committed it.
  if (route.kind === 'dismiss' || !raisedByLiveTurn(ctx, validated)) {
    const dismissed = await dismissPrompt(ctx, validated, true)
    return dismissed.ok ? cancelled : dismissed
  }
  const stopped = await routes.stop()
  if (!stopped.outcome.ok) {
    return stopped.outcome
  }
  // Stop settles the card before child exit; if Stop ends nothing, answer the provider request here.
  const dismissed = await dismissPrompt(ctx, validated, !stopped.endsSession)
  return dismissed.ok ? cancelled : dismissed
}

/** Dismiss ended-generation cards locally; unrouted providers get only named-turn cancel, preserving queues. */
async function cancelEndedGenerationPrompt(
  ctx: AgentSessionTurnContext,
  input: { turnId?: string },
  pending: PendingPrompt,
  interrupt: (() => Promise<CancelOutcome>) | null
): Promise<CancelOutcome> {
  const liveTurnId = contextStructuredAgentSessionCurrentWork(ctx).activeTurnId()
  const interrupted =
    interrupt && input.turnId !== undefined && input.turnId === liveTurnId
      ? await interrupt()
      : null
  if (interrupted && !interrupted.ok) {
    return interrupted
  }
  // Recheck whether provider cancellation already settled the prompt.
  const still = validatePendingPrompt(ctx, {
    itemId: pending.item.itemId,
    expectedRevision: pending.item.revision
  })
  if (still.ok) {
    const dismissed = await dismissPrompt(ctx, still, null)
    if (!dismissed.ok) {
      return dismissed
    }
  }
  return (
    interrupted ?? {
      ok: true,
      value: { ...(input.turnId ? { turnId: input.turnId } : {}), cancelled: true }
    }
  )
}

function raisedByLiveTurn(ctx: AgentSessionTurnContext, pending: PendingPrompt): boolean {
  const live = contextStructuredAgentSessionCurrentWork(ctx).turnScope()
  const raised = pending.item.turnScope
  return live.kind === 'turn' && raised?.kind === 'turn' && raised.turnItemId === live.turnItemId
}

/** Record after prior provider rows; answer declines the request, null means no live provider owns it. */
async function dismissPrompt(
  ctx: AgentSessionTurnContext,
  pending: PendingPrompt,
  answer: boolean | null
): Promise<TurnOutcome<null>> {
  const { item, prompt } = pending
  const identity = parseAgentJournalItemKey(item.itemId)
  if (!identity) {
    return {
      ok: false,
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'requestMalformed' },
        `Item id ${item.itemId} is not a well-formed item key.`
      )
    }
  }
  let committed = false
  const receipt = ctx.operationReceipt?.isCommitted() ? undefined : ctx.operationReceipt
  const commit = async (): Promise<void> => {
    await ctx.journal.appendItem(
      identity,
      {
        ...prompt,
        resolution: {
          state: 'cancelled',
          selectedOptionId: null,
          resolvedBy: ctx.resolvedBy,
          resolvedAt: ctx.now()
        }
      },
      // Revision must preserve the prompt’s original turn.
      { fence: ctx.fence, turnScope: contextStructuredAgentSessionCurrentWork(ctx).turnScope() },
      receipt
    )
    committed = true
  }
  try {
    if (answer !== null) {
      await ctx.adapter.dismissPrompt?.({
        sessionId: ctx.sessionId,
        itemId: item.itemId,
        fence: ctx.fence,
        answer,
        commit
      })
    }
  } catch (error) {
    if (!committed && !(error instanceof AgentSessionPromptUnavailableError)) {
      return dismissalNotSaved(ctx, error)
    }
    if (committed) {
      // Log adapter details locally; journal only the user-facing failure.
      await ctx.journal.appendItem(
        { provider: 'orca', clientMessageId: `${item.itemId}#delivery` },
        {
          kind: 'status',
          ...agentSessionFailureWords(agentSessionFailureFact('answerUnconfirmed'), {
            surface: 'row'
          })
        },
        { fence: ctx.fence, turnScope: contextStructuredAgentSessionCurrentWork(ctx).turnScope() }
      )
    }
  }
  // Provider release does not erase the user’s cancellation.
  if (!committed) {
    try {
      await commit()
    } catch (error) {
      return dismissalNotSaved(ctx, error)
    }
  }
  return { ok: true, value: null }
}

/** Before acceptance, report save failure; after Stop commits its receipt, answer from it. */
function dismissalNotSaved(ctx: AgentSessionTurnContext, error: unknown): TurnOutcome<never> {
  if (ctx.operationReceipt?.isCommitted()) {
    throw error
  }
  return stopNotSaved(ctx, error, {
    log: "saving a card's Cancel failed; the card was not dismissed",
    refusal: cardCancelNotSavedRefusal
  })
}
