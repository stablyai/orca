import { AgentSessionPromptUnavailableError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { MspLiveSession } from './muse-structured-live-session'
import type { MspApprovalRequest, MspUserInputRequest } from './msp-protocol'

export type MspPromptRef =
  | {
      kind: 'approval'
      approvalId: string
      requirementId: string
      turnId: string
      choices: { id: string; label: string; decision: string }[]
    }
  | { kind: 'question'; userInputId: string; turnId: string }

type LiveSession = MspLiveSession

export function journalMspApproval(live: LiveSession, request: MspApprovalRequest): void {
  const itemId = request.itemId || `approval:${request.approvalId}`
  live.prompts.set(itemId, {
    kind: 'approval',
    approvalId: request.approvalId,
    requirementId: request.currentRequirementId ?? request.requirementId ?? '',
    turnId: request.turnId,
    choices: (request.availableChoices ?? []).map((choice) => ({
      id: choice.choiceId,
      label: choice.label,
      decision: choice.decision
    }))
  })
  live.translator.writeApprovalRow(request.approvalId, itemId, request.turnId, {
    kind: 'approval',
    title: request.toolName || 'Approval',
    ...(request.subject ? { description: request.subject } : {}),
    detail: request.rawArgs ?? null,
    options: (request.availableChoices ?? []).map((choice) => ({
      id: choice.choiceId,
      label: choice.label
    })),
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  })
}

export function journalMspQuestion(live: LiveSession, request: MspUserInputRequest): void {
  const itemId = request.itemId || `question:${request.userInputId}`
  live.prompts.set(itemId, {
    kind: 'question',
    userInputId: request.userInputId,
    turnId: request.turnId
  })
  live.translator.writeQuestionRow(request.userInputId, itemId, request.turnId, {
    kind: 'question',
    question: request.questions[0]?.question ?? 'Muse has a question',
    options: [],
    questions: request.questions.map((question) => ({
      id: question.questionId,
      question: question.question,
      ...(question.header ? { header: question.header } : {}),
      multiSelect: question.multiSelect ?? false,
      options: (question.options ?? []).map((option) => ({
        id: option.label,
        label: option.label,
        ...(option.description ? { description: option.description } : {})
      }))
    })),
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  })
}

export async function answerMspPrompt(
  live: LiveSession,
  input: {
    itemId: string
    response:
      | { kind: 'option'; optionId: string }
      | { kind: 'answers'; answers: { questionId: string; optionIds: string[]; other?: string }[] }
    commit: () => Promise<void>
  }
): Promise<void> {
  const ref = live.prompts.get(input.itemId)
  if (!ref) {
    throw new AgentSessionPromptUnavailableError(input.itemId)
  }
  if (ref.kind === 'approval') {
    if (input.response.kind !== 'option') {
      throw new Error('Muse approvals take an option')
    }
    await live.msp.decideApproval(ref.approvalId, ref.requirementId, input.response.optionId)
    live.translator.resolvePromptRow(input.itemId, ref.turnId, {
      state: 'resolved',
      selectedOptionId: input.response.optionId
    })
    await input.commit()
    live.prompts.delete(input.itemId)
    return
  }
  if (input.response.kind !== 'answers') {
    throw new Error('Muse questions take answers')
  }
  const answers = input.response.answers.map((answer) => ({
    questionId: answer.questionId,
    ...(answer.optionIds.length > 0 ? { selectedLabels: answer.optionIds } : {}),
    ...(answer.other ? { freeText: answer.other } : {})
  }))
  await live.msp.answerQuestions(ref.userInputId, answers)
  live.translator.resolvePromptRow(input.itemId, ref.turnId, {
    state: 'resolved',
    selectedOptionId: answers[0]?.selectedLabels?.[0] ?? null
  })
  await input.commit()
  live.prompts.delete(input.itemId)
}

export async function dismissMspPrompt(
  live: LiveSession,
  input: { itemId: string; answer: boolean; commit: () => Promise<void> }
): Promise<void> {
  const ref = live.prompts.get(input.itemId)
  if (!ref) {
    await input.commit()
    return
  }
  if (ref.kind === 'approval') {
    const deny =
      ref.choices.find((choice) => choice.decision.toLowerCase().includes('deny')) ??
      ref.choices.at(-1)
    if (deny && input.answer) {
      await live.msp
        .decideApproval(ref.approvalId, ref.requirementId, deny.id)
        .catch(() => undefined)
    }
  } else if (input.answer) {
    await live.msp.cancelQuestions(ref.userInputId)
  }
  live.translator.resolvePromptRow(input.itemId, ref.turnId, {
    state: 'cancelled',
    selectedOptionId: null
  })
  await input.commit()
  live.prompts.delete(input.itemId)
}
