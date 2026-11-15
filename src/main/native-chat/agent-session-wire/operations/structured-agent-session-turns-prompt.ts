import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import { parseAgentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  agentSessionPromptQuestions,
  isValidAgentSessionQuestionAnswers,
  legacyAgentSessionQuestionAnswers,
  legacyAgentSessionSelectedOptionId,
  type AgentSessionPromptResponse,
  type AgentSessionQuestionAnswer
} from '../../../../shared/agent-session/agent-session-question-answer'
import type {
  AgentJournalApprovalItem,
  AgentJournalQuestionItem,
  AgentJournalResolution
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { refuse } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionPromptResult } from '../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionRefusalReason } from '../../../../shared/agent-session/failures/agent-session-refusal-details'
import '../providers/structured-agent-session-adapter'
import {
  AgentSessionPromptAnswerRejectedError,
  AgentSessionPromptUnavailableError
} from '../providers/structured-agent-session-adapter-errors'
import type { CommandReceiptResult } from '../../agent-session-journal/writing/command-receipt-schema'
import { settledPrompt, validatePendingPrompt } from './structured-agent-session-prompt-state'
import {
  readContextStructuredAgentSessionWork,
  readContextStructuredAgentSessionTurnScope
} from '../observations/structured-agent-session-read-work'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

export type AgentSessionPromptRequest = {
  itemId: string
  expectedRevision: number
  kind: 'approval' | 'question'
  /** Legacy clients pack question answers into optionId. */
  optionId?: string
  answers?: AgentSessionQuestionAnswer[]
  /** Revision feedback paired with a reject-once approval option. */
  feedback?: string
}

function invalid(
  reason: AgentSessionRefusalReason<'agent_session_operation_invalid'>,
  message: string
): TurnOutcome<never> {
  return { ok: false, refusal: refuse('agent_session_operation_invalid', { reason }, message) }
}

function readPromptChoice(
  prompt: AgentJournalApprovalItem | AgentJournalQuestionItem,
  input: AgentSessionPromptRequest
): { response: AgentSessionPromptResponse; selectedOptionId: string } | null {
  if (prompt.kind === 'approval') {
    const optionId = input.optionId
    const matched =
      optionId !== undefined ? prompt.options.find((option) => option.id === optionId) : undefined
    if (!matched) {
      return null
    }
    if (input.feedback !== undefined) {
      if (
        !prompt.freeTextInput ||
        matched.intent !== 'reject_once' ||
        input.feedback.trim().length === 0
      ) {
        return null
      }
      return {
        response: { kind: 'option', optionId: matched.id, feedback: input.feedback },
        selectedOptionId: matched.id
      }
    }
    return { response: { kind: 'option', optionId: matched.id }, selectedOptionId: matched.id }
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

async function resolvedWithSameChoice(
  ctx: AgentSessionTurnContext,
  input: AgentSessionPromptRequest
): Promise<AgentSessionPromptResult | null> {
  const settled = await settledPrompt(ctx, input.itemId)
  if (settled?.prompt.kind !== input.kind || settled.prompt.resolution.state !== 'resolved') {
    return null
  }
  const { item, prompt } = settled
  const choice = readPromptChoice(prompt, input)
  if (!choice || choice.selectedOptionId !== prompt.resolution.selectedOptionId) {
    return null
  }
  if (
    prompt.kind === 'approval' &&
    (choice.response.kind === 'option' ? choice.response.feedback : undefined) !==
      prompt.resolution.feedback
  ) {
    return null
  }
  return { itemId: item.itemId, revision: item.revision, resolution: prompt.resolution }
}

export async function performPrompt(
  ctx: AgentSessionTurnContext,
  input: AgentSessionPromptRequest
): Promise<TurnOutcome<AgentSessionPromptResult>> {
  const validated = await validatePendingPrompt(ctx, input)
  if (!validated.ok) {
    // A retry after a lost reply has a new operation ID; resolved prompt state proves acceptance.
    const held = await resolvedWithSameChoice(ctx, input)
    return held ? { ok: true, value: held } : validated
  }
  const { prompt } = validated
  const work = await readContextStructuredAgentSessionWork(ctx, {
    kind: 'item',
    itemId: input.itemId
  })
  if (!work.current) {
    // Never deliver an old agent’s prompt answer to its replacement.
    return invalid(
      'promptOwnerEnded',
      `Item ${input.itemId} was raised by an agent that has ended.`
    )
  }
  const choice = readPromptChoice(prompt, input)
  if (!choice) {
    return invalid(
      'optionRejected',
      input.optionId !== undefined
        ? input.feedback !== undefined
          ? `Feedback is not valid for option ${input.optionId} on item ${input.itemId}.`
          : `Option ${input.optionId} is not offered by item ${input.itemId}.`
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
    ...(response.kind === 'option' && response.feedback !== undefined
      ? { feedback: response.feedback }
      : {}),
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
        committed.item = await ctx.journal.mutatePrompt(
          {
            itemId: input.itemId,
            expectedRevision: input.expectedRevision,
            kind: input.kind,
            resolution,
            options: {
              fence: ctx.fence,
              turnScope: await readContextStructuredAgentSessionTurnScope(ctx)
            }
          },
          // Commit answer identity before telling the provider.
          ctx.operationReceipt
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
    await ctx.journal.appendItem(
      { provider: 'orca', clientMessageId: `${input.itemId}#delivery` },
      {
        kind: 'status',
        ...agentSessionFailureWords(agentSessionFailureFact('answerUnconfirmed'), {
          surface: 'row'
        })
      },
      { fence: ctx.fence, turnScope: await readContextStructuredAgentSessionTurnScope(ctx) }
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

export function acceptedPromptAnswer(
  receipt: CommandReceiptResult | undefined
): AgentSessionPromptResult | null {
  return receipt?.kind === 'prompt-answer'
    ? { itemId: receipt.itemId, revision: receipt.revision, resolution: receipt.resolution }
    : null
}
