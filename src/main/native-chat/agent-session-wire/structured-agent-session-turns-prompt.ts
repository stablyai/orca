import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  decodeAgentSessionQuestionAnswers,
  isValidAgentSessionQuestionAnswers
} from '../../../shared/agent-session-question-answer'
import type { AgentJournalResolution } from '../../../shared/agent-session-journal-types'
import type { AgentSessionPromptResult } from '../../../shared/agent-session-wire'
import { decodeCodexQuestionOptionId } from '../../codex/codex-structured-prompt-replies'
import { AgentSessionPromptUnavailableError } from './structured-agent-session-adapter'
import { validatePendingPrompt } from './structured-agent-session-prompt-state'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

function invalid(message: string): TurnOutcome<never> {
  return { ok: false, refusal: { code: 'agent_session_operation_invalid', message } }
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
  const validated = validatePendingPrompt(ctx, input)

  if (!validated.ok) {
    return validated
  }

  const { prompt } = validated
  const question = prompt.kind === 'question' ? prompt : null
  const freeText = decodeCodexQuestionOptionId(input.optionId)

  const acceptsFreeText =
    question?.freeTextQuestionId !== undefined &&
    freeText?.questionId === question.freeTextQuestionId &&
    freeText.answer.trim().length > 0

  const grouped = question?.questions ? decodeAgentSessionQuestionAnswers(input.optionId) : null

  const acceptsGrouped =
    grouped !== null &&
    question?.questions !== undefined &&
    isValidAgentSessionQuestionAnswers(question.questions, grouped)

  if (
    !acceptsFreeText &&
    !acceptsGrouped &&
    !prompt.options.some((option) => option.id === input.optionId)
  ) {
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

  const committed: { item?: Awaited<ReturnType<typeof ctx.journal.appendItem>> } = {}

  try {
    await ctx.adapter.answerPrompt({
      sessionId: ctx.sessionId,
      itemId: input.itemId,
      kind: input.kind,
      optionId: input.optionId,
      fence: ctx.fence,
      commit: async () => {
        committed.item = await ctx.journal.appendItem(
          identity,
          { ...prompt, resolution },
          {
            fence: ctx.fence
          }
        )
        ctx.publish()
      }
    })
  } catch (error) {
    if (!committed.item && error instanceof AgentSessionPromptUnavailableError) {
      return invalid(error.message)
    }

    if (!committed.item) {
      throw error
    }

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

  const appended = committed.item

  if (!appended) {
    throw new Error(`Provider adapter did not commit prompt ${input.itemId}.`)
  }

  return {
    ok: true,
    value: { itemId: appended.itemId, revision: appended.revision, resolution }
  }
}
