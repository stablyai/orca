import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalResolution
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionPromptResult } from '../../../shared/agent-session-wire'
import { decodeCodexQuestionOptionId } from '../../codex/codex-structured-prompt-replies'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

function invalid(message: string): TurnOutcome<never> {
  return { ok: false, refusal: { code: 'agent_session_operation_invalid', message } }
}

function promptBodyOf(body: AgentJournalItemBody): {
  options: readonly { id: string }[]
  freeTextQuestionId?: string
  resolution: AgentJournalResolution
} | null {
  return body.kind === 'approval' || body.kind === 'question' ? body : null
}

export async function performPrompt(
  ctx: AgentSessionTurnContext,
  input: {
    itemId: string
    expectedRevision: number
    optionId: string
    kind: 'approval' | 'question'
  }
): Promise<TurnOutcome<AgentSessionPromptResult>> {
  const item = ctx.journal.snapshot().items.find((entry) => entry.itemId === input.itemId)
  if (!item) {
    return invalid(`No item ${input.itemId} in session ${ctx.sessionId}.`)
  }
  const prompt = promptBodyOf(item.body)
  if (!prompt || item.body.kind !== input.kind) {
    return invalid(`Item ${input.itemId} is not a pending ${input.kind}.`)
  }
  if (item.revision !== input.expectedRevision) {
    return {
      ok: false,
      refusal: {
        code: 'agent_session_item_revision_stale',
        message: `Item ${input.itemId} has moved on.`,
        currentRevision: item.revision,
        resolution: prompt.resolution
      }
    }
  }
  if (prompt.resolution.state !== 'pending') {
    return {
      ok: false,
      refusal: {
        code: 'agent_session_already_resolved',
        message: `Item ${input.itemId} was already ${prompt.resolution.state}.`,
        currentRevision: item.revision,
        resolution: prompt.resolution
      }
    }
  }
  const freeText = decodeCodexQuestionOptionId(input.optionId)
  const acceptsFreeText =
    item.body.kind === 'question' &&
    prompt.freeTextQuestionId !== undefined &&
    freeText?.questionId === prompt.freeTextQuestionId &&
    freeText.answer.trim().length > 0
  if (!acceptsFreeText && !prompt.options.some((option) => option.id === input.optionId)) {
    return invalid(`Option ${input.optionId} is not offered by item ${input.itemId}.`)
  }
  const identity = parseAgentJournalItemKey(input.itemId)
  if (!identity) {
    return invalid(`Item id ${input.itemId} is not a well-formed item key.`)
  }

  const resolution: AgentJournalResolution = {
    state: 'resolved',
    selectedOptionId: input.optionId,
    resolvedBy: ctx.resolvedBy,
    resolvedAt: ctx.now()
  }
  const appended = await ctx.journal.appendItem(
    identity,
    { ...item.body, resolution },
    {
      fence: ctx.fence
    }
  )
  ctx.publish()

  try {
    await ctx.adapter.answerPrompt({
      sessionId: ctx.sessionId,
      itemId: input.itemId,
      kind: input.kind,
      optionId: input.optionId,
      fence: ctx.fence
    })
  } catch (error) {
    await ctx.journal.appendItem(
      { provider: 'orca', clientMessageId: `${input.itemId}#delivery` },
      {
        kind: 'status',
        text: `Your answer was recorded but the agent did not confirm it: ${
          error instanceof Error ? error.message : String(error)
        }`
      },
      { fence: ctx.fence }
    )
    ctx.publish()
  }
  return {
    ok: true,
    value: { itemId: appended.itemId, revision: appended.revision, resolution }
  }
}
