import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentSessionPromptResponse,
  AgentSessionQuestionAnswer
} from '../../shared/agent-session-question-answer'
import {
  claudePromptQuestions,
  isClaudePromptRecord,
  readClaudePromptString,
  type ClaudePendingPrompt
} from './claude-prompt-registry'
export {
  ClaudePromptRegistry,
  type ClaudePendingPrompt,
  type ClaudePromptClaim,
  type ClaudePromptPresentation,
  type ClaudePromptRegistration,
  type ClaudePromptSettle
} from './claude-prompt-registry'

export const CLAUDE_APPROVAL_DECISIONS = ['allow', 'allowForSession', 'deny', 'cancel'] as const
export type ClaudeApprovalDecision = (typeof CLAUDE_APPROVAL_DECISIONS)[number]

function isClaudeApprovalDecision(optionId: string): optionId is ClaudeApprovalDecision {
  return CLAUDE_APPROVAL_DECISIONS.some((decision) => decision === optionId)
}

function questionAnswer(prompt: ClaudePendingPrompt, questionId: string, optionId: string): string {
  const decoded = decodeClaudeQuestionOptionId(optionId)
  if (!decoded) {
    return optionId
  }
  const questionIndex = prompt.questionIds.indexOf(questionId)
  if (questionIndex === -1) {
    return optionId
  }
  const choice = /^choice-([1-9]\d*)$/.exec(decoded.answer)
  const optionIndex = choice ? Number(choice[1]) - 1 : -1
  const question = claudePromptQuestions(prompt.input)[questionIndex]
  const options = Array.isArray(question?.options) ? question.options : []
  const option = options[optionIndex]
  const label = isClaudePromptRecord(option) ? readClaudePromptString(option.label) : null
  if (decoded.questionId === `q${questionIndex + 1}` && label) {
    return label
  }
  if (decoded.questionId === `q${questionIndex + 1}`) {
    return decoded.answer
  }
  const legacyChoice = options.some(
    (candidate) =>
      isClaudePromptRecord(candidate) && readClaudePromptString(candidate.label) === decoded.answer
  )
  return decoded.questionId === questionId && (legacyChoice || decoded.answer.trim().length > 0)
    ? decoded.answer
    : optionId
}

export function encodeClaudeQuestionOptionId(questionId: string, answer: string): string {
  return `${encodeURIComponent(questionId)}:${encodeURIComponent(answer)}`
}

export function decodeClaudeQuestionOptionId(
  optionId: string
): { questionId: string; answer: string } | null {
  const separator = optionId.indexOf(':')
  if (separator <= 0) {
    return null
  }
  try {
    return {
      questionId: decodeURIComponent(optionId.slice(0, separator)),
      answer: decodeURIComponent(optionId.slice(separator + 1))
    }
  } catch {
    return null
  }
}

function approvalResponse(prompt: ClaudePendingPrompt, optionId: string): PermissionResult {
  if (!isClaudeApprovalDecision(optionId)) {
    throw new Error(`${optionId} is not a Claude approval decision`)
  }
  const decision = optionId
  if (decision === 'allow' || decision === 'allowForSession') {
    return {
      behavior: 'allow',
      updatedInput: prompt.input,
      ...(decision === 'allowForSession' &&
      prompt.subject?.kind !== 'plan' &&
      prompt.suggestions.length > 0
        ? { updatedPermissions: prompt.suggestions }
        : {}),
      toolUseID: prompt.toolUseId
    }
  }
  return {
    behavior: 'deny',
    message:
      decision === 'cancel'
        ? 'User stopped this turn.'
        : prompt.subject?.kind === 'plan'
          ? 'The user asked you to keep planning. Revise the plan and call ExitPlanMode again.'
          : 'User denied this action.',
    ...(decision === 'cancel' ? { interrupt: true } : {}),
    toolUseID: prompt.toolUseId
  }
}

function questionResponse(
  prompt: ClaudePendingPrompt,
  grouped: readonly AgentSessionQuestionAnswer[]
): PermissionResult {
  const questions = claudePromptQuestions(prompt.input)
  if (grouped.length !== prompt.questionIds.length) {
    throw new Error(`Grouped answer does not match Claude prompt ${prompt.promptKey}`)
  }
  const answers: Record<string, string | readonly string[]> = {}
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]
    const providerQuestionId = prompt.questionIds[index]
    const answer = grouped.find((entry) => entry.questionId === `q${index + 1}`)
    if (!question || !providerQuestionId || !answer) {
      throw new Error(`Grouped answer does not name question ${index + 1}`)
    }
    const selected = answer.optionIds.map((selectedId) =>
      questionAnswer(prompt, providerQuestionId, selectedId)
    )
    const other = answer.other?.trim()
    if (question.multiSelect === true) {
      const values = [...selected, ...(other ? [other] : [])]
      if (values.length === 0) {
        throw new Error(`Grouped answer leaves question ${index + 1} empty`)
      }
      answers[providerQuestionId] = values
    } else {
      const value = other || selected[0]
      if (!value || selected.length > 1) {
        throw new Error(`Grouped answer is invalid for question ${index + 1}`)
      }
      answers[providerQuestionId] = value
    }
  }
  return {
    behavior: 'allow',
    updatedInput: { ...prompt.input, answers },
    toolUseID: prompt.toolUseId
  }
}

/** Builds Claude's reply without touching the prompt, so a reply that cannot be built refuses the
 *  answer before anything is recorded. */
export function buildClaudePromptReply(
  prompt: ClaudePendingPrompt,
  response: AgentSessionPromptResponse
): PermissionResult {
  if (prompt.kind === 'approval') {
    if (response.kind !== 'option') {
      throw new Error(`Claude prompt ${prompt.promptKey} takes a decision, not answers`)
    }
    return approvalResponse(prompt, response.optionId)
  }
  if (response.kind !== 'answers') {
    throw new Error(`Claude prompt ${prompt.promptKey} takes answers, not a decision`)
  }
  return questionResponse(prompt, response.answers)
}
