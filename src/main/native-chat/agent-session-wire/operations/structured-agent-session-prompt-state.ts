import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionCancelResult } from '../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'
import { readContextStructuredAgentSessionWork } from '../observations/structured-agent-session-read-work'

import {
  validateJournalPendingPrompt,
  type PendingPromptBody,
  type PendingPromptValidation
} from '../../agent-session-journal/writing/journal-prompt-mutation'
export type { PendingPromptValidation } from '../../agent-session-journal/writing/journal-prompt-mutation'

export async function settledPrompt(
  ctx: Pick<AgentSessionTurnContext, 'journal'>,
  itemId: string
): Promise<{ item: AgentJournalRenderItem; prompt: PendingPromptBody } | null> {
  const item = await ctx.journal.reads.item(itemId)
  const prompt = item?.body.kind === 'approval' || item?.body.kind === 'question' ? item.body : null
  return item && prompt && prompt.resolution.state !== 'pending' ? { item, prompt } : null
}

/** Repeated Cancel of a cancelled prompt succeeds without effects. */
export async function answerCancelOfSettledPrompt(
  ctx: Pick<AgentSessionTurnContext, 'journal'>,
  input: { turnId?: string; prompt: { itemId: string } },
  refused: Extract<PendingPromptValidation, { ok: false }>
): Promise<TurnOutcome<AgentSessionCancelResult>> {
  return (await settledPrompt(ctx, input.prompt.itemId))?.prompt.resolution.state === 'cancelled'
    ? {
        ok: true,
        value: { ...(input.turnId !== undefined ? { turnId: input.turnId } : {}), cancelled: false }
      }
    : refused
}

export async function validatePendingPrompt(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'sessionId'>,
  input: { itemId: string; expectedRevision: number; kind?: 'approval' | 'question' }
): Promise<PendingPromptValidation> {
  return validateJournalPendingPrompt(
    (await ctx.journal.reads.item(input.itemId)) ?? undefined,
    ctx.sessionId,
    input
  )
}

/** Ended-generation prompts have no live owner. */
export async function isEndedGenerationPrompt(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence' | 'currentWork' | 'readWork'>,
  pending: Extract<PendingPromptValidation, { ok: true }>
): Promise<boolean> {
  return !(
    await readContextStructuredAgentSessionWork(ctx, { kind: 'item', itemId: pending.item.itemId })
  ).current
}
