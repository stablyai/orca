// A prompt card's own Cancel, routed the way its provider says: a dismissal, or the chat's Stop. A
// provider that says nothing interrupts the turn holding the card. The host decides, so a client of
// any version gets the same Cancel.

import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { refuse, type AgentSessionCancelResult } from '../../../shared/agent-session-wire'
import { AgentSessionPromptUnavailableError } from './structured-agent-session-adapter'
import type { StructuredAgentSessionChatStopRun } from './structured-agent-session-chat-stop'
import {
  answerCancelOfSettledPrompt,
  validatePendingPrompt,
  type PendingPromptValidation
} from './structured-agent-session-prompt-state'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

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
  if (!route) {
    return routes.interrupt()
  }
  const cancelled: CancelOutcome = {
    ok: true,
    value: { ...(input.turnId ? { turnId: input.turnId } : {}), cancelled: true }
  }
  if (route.kind === 'dismiss') {
    const dismissed = await dismissPrompt(ctx, validated, true)
    return dismissed.ok ? cancelled : dismissed
  }
  // Judged on the fold as it stands: the provider's own cancel of the card, or the end of the turn
  // that raised it, landed when it was handed over.
  if (!raisedByLiveTurn(ctx, validated)) {
    // A request that outlived its turn, such as a background agent's: the turn running now is not
    // the one the user is cancelling, so nothing stops and the request is declined.
    const dismissed = await dismissPrompt(ctx, validated, true)
    return dismissed.ok ? cancelled : dismissed
  }
  const stopped = await routes.stop()
  if (!stopped.outcome.ok) {
    return stopped.outcome
  }
  // Settled in the Stop's own step, so the card is not answerable while the child ends. That end
  // takes the provider's request with it; a Stop that ends nothing must answer the request itself.
  const dismissed = await dismissPrompt(ctx, validated, !stopped.endsSession)
  return dismissed.ok ? cancelled : dismissed
}

function raisedByLiveTurn(ctx: AgentSessionTurnContext, pending: PendingPrompt): boolean {
  const live = ctx.journal.liveTurnScope()
  const raised = pending.item.turnScope
  return live.kind === 'turn' && raised?.kind === 'turn' && raised.turnItemId === live.turnItemId
}

/** Records the card as cancelled by the caller, after every row the provider already sent (each
 *  landed at its call); `answer` also declines the provider's request. */
async function dismissPrompt(
  ctx: AgentSessionTurnContext,
  pending: PendingPrompt,
  answer: boolean
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
      // A revision: the prompt keeps the turn it was raised in.
      { fence: ctx.fence, turnScope: ctx.journal.liveTurnScope() }
    )
    committed = true
  }
  try {
    await ctx.adapter.dismissPrompt?.({
      sessionId: ctx.sessionId,
      itemId: item.itemId,
      fence: ctx.fence,
      answer,
      commit
    })
  } catch (error) {
    if (!committed && !(error instanceof AgentSessionPromptUnavailableError)) {
      throw error
    }
    if (committed) {
      // The adapter's error is Orca's; the row says only what the user needs to know.
      await ctx.journal.appendItem(
        { provider: 'orca', clientMessageId: `${item.itemId}#delivery` },
        {
          kind: 'status',
          ...agentSessionFailureWords(agentSessionFailureFact('answerUnconfirmed'), {
            surface: 'row'
          })
        },
        { fence: ctx.fence, turnScope: ctx.journal.liveTurnScope() }
      )
    }
  }
  // A request the provider already let go of, by its own cancel or the child's end, is still the
  // user's to have cancelled.
  if (!committed) {
    await commit()
  }
  return { ok: true, value: null }
}
