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
  // Judged on the fold as it stands: the provider's own cancel of the card, or the end of the turn
  // that raised it, landed when it was handed over. A request that outlived its turn, such as a
  // background agent's, is not the running turn's: nothing stops and the request is declined.
  // The dismissal's row carries the Cancel's receipt, unless the Stop already saved it.
  if (route.kind === 'dismiss' || !raisedByLiveTurn(ctx, validated)) {
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

/** A card an ended generation raised: no live provider holds it, so it is dismissed in the journal
 *  alone. As on main, a provider whose card Cancel routes (a dismissal, or a Stop of the turn that
 *  raised it) stops nothing, since the live turn did not raise it. One with no route gets the
 *  named live turn's own cancel with the card, as main's plan does, never the chat's Stop, so
 *  queued messages stay and the queue is not paused: ACP interrupts that turn, and Codex, finding
 *  no such card in its live child, interrupts nothing. */
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
  // The interrupt's provider may have let go of it already; what is still pending is dismissed.
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

/** Records the card as cancelled by the caller, after every row the provider already sent (each
 *  landed at its call); `answer` also declines the provider's request. Null: no live provider holds
 *  the card (an ended generation's), so only the journal records it. */
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
      // A revision: the prompt keeps the turn it was raised in.
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
      // The adapter's error is Orca's; the row says only what the user needs to know.
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
  // A request the provider already let go of, by its own cancel or the child's end, is still the
  // user's to have cancelled.
  if (!committed) {
    try {
      await commit()
    } catch (error) {
      return dismissalNotSaved(ctx, error)
    }
  }
  return { ok: true, value: null }
}

/** Nothing of the Cancel saved: refused in words about the card, which stands. Once a Stop saved
 *  the receipt, the failure is answered from it. */
function dismissalNotSaved(ctx: AgentSessionTurnContext, error: unknown): TurnOutcome<never> {
  if (ctx.operationReceipt?.isCommitted()) {
    throw error
  }
  return stopNotSaved(ctx, error, {
    log: "saving a card's Cancel failed; the card was not dismissed",
    refusal: cardCancelNotSavedRefusal
  })
}
