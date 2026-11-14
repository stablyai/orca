import { isPlanApprovalSubject } from '../../../../shared/agent-session/agent-session-approval-subject'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { captureStructuredExecutionOptions } from '../options/structured-agent-session-execution-options'
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
  AgentJournalMessageItem,
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
import type { JournalRow } from '../../agent-session-journal/durable-rows/journal-row-schema'
import { settledPrompt, validatePendingPrompt } from './structured-agent-session-prompt-state'
import { contextStructuredAgentSessionCurrentWork } from '../observations/structured-agent-session-current-work'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

export type AgentSessionPromptRequest = {
  itemId: string
  expectedRevision: number
  kind: 'approval' | 'question'
  /** Legacy clients pack question answers into optionId. */
  optionId?: string
  answers?: AgentSessionQuestionAnswer[]
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

function resolvedWithSameChoice(
  ctx: AgentSessionTurnContext,
  input: AgentSessionPromptRequest
): AgentSessionPromptResult | null {
  const settled = settledPrompt(ctx, input.itemId)
  if (settled?.prompt.kind !== input.kind || settled.prompt.resolution.state !== 'resolved') {
    return null
  }
  const { item, prompt } = settled
  const choice = readPromptChoice(prompt, input)
  return choice?.selectedOptionId === prompt.resolution.selectedOptionId
    ? { itemId: item.itemId, revision: item.revision, resolution: prompt.resolution }
    : null
}

export async function performPrompt(
  ctx: AgentSessionTurnContext,
  input: AgentSessionPromptRequest
): Promise<TurnOutcome<AgentSessionPromptResult>> {
  const validated = validatePendingPrompt(ctx, input)
  if (!validated.ok) {
    // A retry after a lost reply has a new operation ID; resolved prompt state proves acceptance.
    const held = resolvedWithSameChoice(ctx, input)
    return held ? { ok: true, value: held } : validated
  }
  const { prompt } = validated
  const work = contextStructuredAgentSessionCurrentWork(ctx)
  if (!work.attentionPrompts().some((item) => item.itemId === input.itemId)) {
    return invalid('promptOwnerEnded', 'This question is no longer waiting for an answer.')
  }
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
  if (!work.isCurrentItem(input.itemId)) {
    if (!ctx.operationId) {
      return invalid('promptOwnerEnded', 'This question is no longer waiting for an answer.')
    }
    const body = savedPromptAnswerMessage(prompt, response)
    const interactionMode =
      ctx.agent === 'claude' ? promptAnswerInteractionMode({ ...prompt, resolution }) : undefined
    const captured = captureStructuredExecutionOptions(
      ctx,
      interactionMode ? { interactionMode } : undefined
    )
    if ('refusal' in captured) {
      return { ok: false, refusal: captured.refusal }
    }
    await ctx.journal.appendSubmission(
      {
        clientMessageId: ctx.operationId,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: ctx.sessionId,
          fields: { body }
        }),
        body,
        fence: ctx.fence,
        origin: 'client',
        source: { kind: 'user' },
        handoverRecorded: true,
        options: captured.options
      },
      undefined,
      ctx.operationReceipt,
      {
        itemId: input.itemId,
        expectedRevision: input.expectedRevision,
        contextEpoch: ctx.journal.cursor().epoch,
        identity,
        body: { ...prompt, resolution },
        options: {
          ...validated.item,
          fence: ctx.fence,
          turnScope: validated.item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
        }
      }
    )
    const item = ctx.journal.item(input.itemId)!
    return { ok: true, value: { itemId: item.itemId, revision: item.revision, resolution } }
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
          { fence: ctx.fence, turnScope: work.turnScope() },
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
      { fence: ctx.fence, turnScope: contextStructuredAgentSessionCurrentWork(ctx).turnScope() }
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

export function promptRowAnswer(row: JournalRow | undefined): AgentSessionPromptResult {
  const body = row?.kind === 'item' ? row.body : undefined
  if (row?.kind !== 'item' || (body?.kind !== 'approval' && body?.kind !== 'question')) {
    throw new Error('an accepted prompt answer requires its prompt row')
  }
  return { itemId: row.itemId, revision: row.revision, resolution: body.resolution }
}

/** Capture replay data now so later revisions or rewind cannot change an accepted answer. */
export function promptAnswerReceipt(answer: AgentSessionPromptResult): CommandReceiptResult {
  const { state, selectedOptionId, answers, resolvedBy, resolvedAt } = answer.resolution
  if (state !== 'resolved') {
    throw new Error('an accepted prompt answer is resolved')
  }
  return {
    kind: 'prompt-answer',
    itemId: answer.itemId,
    revision: answer.revision,
    resolution: {
      state,
      selectedOptionId,
      ...(answers
        ? {
            answers: answers.map(({ questionId, optionIds, other }) => ({
              questionId,
              optionIds,
              ...(other === undefined ? {} : { other })
            }))
          }
        : {}),
      resolvedBy,
      resolvedAt
    }
  }
}

export function acceptedPromptAnswer(
  receipt: CommandReceiptResult | undefined
): AgentSessionPromptResult | null {
  return receipt?.kind === 'prompt-answer'
    ? { itemId: receipt.itemId, revision: receipt.revision, resolution: receipt.resolution }
    : null
}

/** The exact plan subject changes mode with its answer, including an ordinary saved-request answer. */
export function promptAnswerInteractionMode(
  body: AgentJournalApprovalItem | AgentJournalQuestionItem | undefined
): 'default' | 'plan' | undefined {
  if (
    body?.kind !== 'approval' ||
    body.resolution.state !== 'resolved' ||
    !isPlanApprovalSubject(body.subject)
  ) {
    return undefined
  }
  const choice = body.resolution.selectedOptionId
  return choice === 'allow' || choice === 'allowForSession'
    ? 'default'
    : choice === 'deny'
      ? 'plan'
      : undefined
}

function savedPromptAnswerMessage(
  prompt: AgentJournalApprovalItem | AgentJournalQuestionItem,
  response: AgentSessionPromptResponse
): AgentJournalMessageItem {
  const text =
    prompt.kind === 'approval' && response.kind === 'option'
      ? `For your saved request: ${prompt.title}\n${prompt.detail ?? prompt.description ?? ''}\nMy choice: ${prompt.options.find((option) => option.id === response.optionId)?.label ?? response.optionId}. Recheck the action and continue the unfinished task using this instruction.`
      : prompt.kind === 'question' && response.kind === 'answers'
        ? agentSessionPromptQuestions(prompt)
            .map((question) => {
              const answer = response.answers.find((value) => value.questionId === question.id)!
              return `${question.question}\nMy answer: ${[...answer.optionIds.map((id) => question.options.find((option) => option.id === id)?.label ?? id), ...(answer.other === undefined ? [] : [answer.other])].join(', ')}`
            })
            .join('\n\n')
        : ''
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}
