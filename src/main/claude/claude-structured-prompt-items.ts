import type {
  AgentJournalApprovalItem,
  AgentJournalItemIdentity,
  AgentJournalPromptOption,
  AgentJournalQuestion,
  AgentJournalQuestionItem
} from '../../shared/agent-session-journal-types'
import { formatToolInput, truncateToolDetail } from '../../shared/native-chat-tool-summary'
import { boundJournalPromptBody } from '../native-chat/agent-session-journal/journal-prompt-body-bounds'
import { claudeRecord, claudeText } from './claude-structured-item-translation'
import {
  CLAUDE_APPROVAL_DECISIONS,
  encodeClaudeQuestionOptionId,
  type ClaudeApprovalDecision,
  type ClaudePendingPrompt
} from './claude-structured-prompt-replies'

const APPROVAL_LABELS: Record<ClaudeApprovalDecision, string> = {
  allow: 'Allow',
  allowForSession: 'Allow for this session',
  deny: 'Deny',
  cancel: 'Stop'
}

const PENDING = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
} as const

export function claudePromptIdentity(input: {
  sessionId: string
  promptKey: string
  questionId?: string
}): AgentJournalItemIdentity {
  const suffix = input.questionId ? `:${input.questionId}` : ''
  return {
    provider: 'orca',
    clientMessageId: `claude-prompt:${input.sessionId}:${input.promptKey}${suffix}`
  }
}

export function claudeApprovalItem(prompt: ClaudePendingPrompt): AgentJournalApprovalItem {
  const detail = truncateToolDetail(formatToolInput(prompt.input))
  return boundJournalPromptBody({
    kind: 'approval',
    title: prompt.title ?? `Allow ${prompt.toolName}?`,
    ...(prompt.displayName ? { displayName: prompt.displayName } : {}),
    ...(prompt.description ? { description: prompt.description } : {}),
    ...(prompt.decisionReason ? { decisionReason: prompt.decisionReason } : {}),
    ...(prompt.blockedPath ? { blockedPath: prompt.blockedPath } : {}),
    ...(prompt.matchedAskRule ? { matchedAskRule: prompt.matchedAskRule } : {}),
    detail: detail || null,
    options: CLAUDE_APPROVAL_DECISIONS.map((decision) => ({
      id: decision,
      label: APPROVAL_LABELS[decision]
    })),
    resolution: { ...PENDING }
  })
}

export type ClaudeQuestionItem = {
  identity: AgentJournalItemIdentity
  body: AgentJournalQuestionItem
}

function questionOptions(
  question: Record<string, unknown>,
  questionAddress: string
): AgentJournalPromptOption[] {
  if (!Array.isArray(question.options)) {
    return []
  }
  return question.options.flatMap((value, index) => {
    const option = claudeRecord(value)
    const label = claudeText(option?.label)
    const description = claudeText(option?.description)
    return label
      ? [
          {
            id: encodeClaudeQuestionOptionId(questionAddress, `choice-${index + 1}`),
            label,
            ...(description ? { description } : {})
          }
        ]
      : []
  })
}

export function claudeQuestionItems(input: {
  sessionId: string
  prompt: ClaudePendingPrompt
}): ClaudeQuestionItem[] {
  const values = Array.isArray(input.prompt.input.questions) ? input.prompt.input.questions : []
  const questions = values.flatMap((value, index): AgentJournalQuestion[] => {
    const question = claudeRecord(value)
    const questionAddress = `q${index + 1}`
    const text = claudeText(question?.question) ?? claudeText(question?.header)
    const header = claudeText(question?.header)
    return question && input.prompt.questionIds[index] && text
      ? [
          {
            id: questionAddress,
            question: text,
            ...(header ? { header } : {}),
            options: questionOptions(question, questionAddress),
            multiSelect: question.multiSelect === true,
            freeTextQuestionId: questionAddress
          }
        ]
      : []
  })
  if (questions.length === 0) {
    return []
  }
  const legacyCompatible = questions.length === 1 && questions[0]?.multiSelect === false
  const first = questions[0]!
  return [
    {
      identity: claudePromptIdentity({
        sessionId: input.sessionId,
        promptKey: input.prompt.promptKey
      }),
      body: boundJournalPromptBody({
        kind: 'question',
        question: legacyCompatible
          ? first.question
          : `${questions.length} grouped question${questions.length === 1 ? '' : 's'} from Claude`,
        options: legacyCompatible ? first.options : [],
        ...(legacyCompatible ? { freeTextQuestionId: first.freeTextQuestionId } : {}),
        questions,
        resolution: { ...PENDING }
      })
    }
  ]
}
