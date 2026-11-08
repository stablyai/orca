import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionCancelResult } from '../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'
import { contextStructuredAgentSessionCurrentWork } from '../observations/structured-agent-session-current-work'

import {
  validateJournalPendingPrompt,
  type PendingPromptBody,
  type PendingPromptValidation
} from '../../agent-session-journal/writing/journal-prompt-mutation'
export type { PendingPromptValidation } from '../../agent-session-journal/writing/journal-prompt-mutation'

export function settledPrompt(
  ctx: Pick<AgentSessionTurnContext, 'journal'>,
  itemId: string
): { item: AgentJournalRenderItem; prompt: PendingPromptBody } | null {
  const item = ctx.journal.itemsRead().items.find((entry) => entry.itemId === itemId)
  const prompt = item?.body.kind === 'approval' || item?.body.kind === 'question' ? item.body : null
  return item && prompt && prompt.resolution.state !== 'pending' ? { item, prompt } : null
}

/** Repeated Cancel of a cancelled prompt succeeds without effects. */
export function answerCancelOfSettledPrompt(
  ctx: Pick<AgentSessionTurnContext, 'journal'>,
  input: { turnId?: string; prompt: { itemId: string } },
  refused: Extract<PendingPromptValidation, { ok: false }>
): TurnOutcome<AgentSessionCancelResult> {
  return settledPrompt(ctx, input.prompt.itemId)?.prompt.resolution.state === 'cancelled'
    ? {
        ok: true,
        value: { ...(input.turnId !== undefined ? { turnId: input.turnId } : {}), cancelled: false }
      }
    : refused
}

export function validatePendingPrompt(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'sessionId'>,
  input: { itemId: string; expectedRevision: number; kind?: 'approval' | 'question' }
): PendingPromptValidation {
  return validateJournalPendingPrompt(
    ctx.journal.itemsRead().items.find((entry) => entry.itemId === input.itemId) ?? undefined,
    ctx.sessionId,
    input
  )
}

/** Ended-generation prompts have no live owner. */
export function isEndedGenerationPrompt(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence' | 'currentWork'>,
  pending: Extract<PendingPromptValidation, { ok: true }>
): boolean {
  return !contextStructuredAgentSessionCurrentWork(ctx).isCurrentItem(pending.item.itemId)
}
