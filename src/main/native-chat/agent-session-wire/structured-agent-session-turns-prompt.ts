import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureText } from './structured-agent-session-failure-text'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  decodeAgentSessionQuestionAnswers,
  isValidAgentSessionQuestionAnswers
} from '../../../shared/agent-session-question-answer'
import type { AgentJournalResolution } from '../../../shared/agent-session-journal-types'
import {
  refuse,
  type AgentSessionPromptResult,
  type AgentSessionRefusalCause
} from '../../../shared/agent-session-wire'
import { decodeCodexQuestionOptionId } from '../../codex/codex-structured-prompt-replies'
import { AgentSessionPromptUnavailableError } from './structured-agent-session-adapter'
import { validatePendingPrompt } from './structured-agent-session-prompt-state'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

function invalid(cause: AgentSessionRefusalCause, message: string): TurnOutcome<never> {
  return { ok: false, refusal: refuse('agent_session_operation_invalid', cause, message) }
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
    return invalid(
      'optionRejected',
      `Option ${input.optionId} is not offered by item ${input.itemId}.`
    )
  }
  const identity = parseAgentJournalItemKey(input.itemId)
  if (!identity) {
    return invalid('requestMalformed', `Item id ${input.itemId} is not a well-formed item key.`)
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
      }
    })
  } catch (error) {
    if (!committed.item && error instanceof AgentSessionPromptUnavailableError) {
      return invalid('promptGone', error.message)
    }
    if (!committed.item) {
      throw error
    }
    // The adapter's error is Orca's; the row says only what the user needs to know.
    const failure = agentSessionFailureFact('answerUnconfirmed')
    await ctx.journal.appendItem(
      { provider: 'orca', clientMessageId: `${input.itemId}#delivery` },
      { kind: 'status', text: agentSessionFailureText(failure), failure },
      { fence: ctx.fence }
    )
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
