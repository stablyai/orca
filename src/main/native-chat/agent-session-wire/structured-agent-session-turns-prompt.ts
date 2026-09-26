import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureText } from './structured-agent-session-failure-text'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  agentSessionPromptQuestions,
  isValidAgentSessionQuestionAnswers,
  legacyAgentSessionQuestionAnswers,
  legacyAgentSessionSelectedOptionId,
  type AgentSessionPromptResponse,
  type AgentSessionQuestionAnswer
} from '../../../shared/agent-session-question-answer'
import type {
  AgentJournalApprovalItem,
  AgentJournalQuestionItem,
  AgentJournalResolution
} from '../../../shared/agent-session-journal-types'
import {
  refuse,
  type AgentSessionPromptResult,
  type AgentSessionRefusalCause
} from '../../../shared/agent-session-wire'
import {
  AgentSessionPromptAnswerRejectedError,
  AgentSessionPromptUnavailableError
} from './structured-agent-session-adapter'
import { validatePendingPrompt } from './structured-agent-session-prompt-state'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

export type AgentSessionPromptRequest = {
  itemId: string
  expectedRevision: number
  kind: 'approval' | 'question'
  /** A decision id; or, from a client that predates `answers`, a question answer packed into one id. */
  optionId?: string
  answers?: AgentSessionQuestionAnswer[]
}

function invalid(cause: AgentSessionRefusalCause, message: string): TurnOutcome<never> {
  return { ok: false, refusal: refuse('agent_session_operation_invalid', cause, message) }
}

/** The one place a client's choice is read; an answer an older client packed into `optionId` is unpacked here, once. */
function readPromptChoice(
  prompt: AgentJournalApprovalItem | AgentJournalQuestionItem,
  input: AgentSessionPromptRequest
): { response: AgentSessionPromptResponse; selectedOptionId: string } | null {
  if (prompt.kind === 'approval') {
    const optionId = input.optionId
    return optionId !== undefined && prompt.options.some((option) => option.id === optionId)
      ? { response: { kind: 'option', optionId }, selectedOptionId: optionId }
      : null
  }
  const answers =
    input.answers ??
    (input.optionId === undefined
      ? null
      : legacyAgentSessionQuestionAnswers(prompt, input.optionId))
  if (
    !answers ||
    !isValidAgentSessionQuestionAnswers(agentSessionPromptQuestions(prompt), answers)
  ) {
    return null
  }
  const selectedOptionId = legacyAgentSessionSelectedOptionId(prompt, answers)
  return selectedOptionId === null
    ? null
    : { response: { kind: 'answers', answers }, selectedOptionId }
}

export async function performPrompt(
  ctx: AgentSessionTurnContext,
  input: AgentSessionPromptRequest
): Promise<TurnOutcome<AgentSessionPromptResult>> {
  const validated = validatePendingPrompt(ctx, input)
  if (!validated.ok) {
    return validated
  }
  const { prompt } = validated
  const choice = readPromptChoice(prompt, input)
  if (!choice) {
    return invalid(
      'optionRejected',
      input.optionId !== undefined
        ? `Option ${input.optionId} is not offered by item ${input.itemId}.`
        : `The answers do not match the questions on item ${input.itemId}.`
    )
  }
  const { response } = choice
  const identity = parseAgentJournalItemKey(input.itemId)
  if (!identity) {
    return invalid('requestMalformed', `Item id ${input.itemId} is not a well-formed item key.`)
  }

  const resolution: AgentJournalResolution = {
    state: 'resolved',
    selectedOptionId: choice.selectedOptionId,
    ...(response.kind === 'answers' ? { answers: response.answers } : {}),
    resolvedBy: ctx.resolvedBy,
    resolvedAt: ctx.now()
  }
  const committed: { item?: Awaited<ReturnType<typeof ctx.journal.appendItem>> } = {}
  try {
    await ctx.adapter.answerPrompt({
      sessionId: ctx.sessionId,
      itemId: input.itemId,
      kind: input.kind,
      response,
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
    if (!committed.item && error instanceof AgentSessionPromptAnswerRejectedError) {
      return invalid('optionRejected', error.message)
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
