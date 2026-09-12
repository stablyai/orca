import type {
  AgentJournalApprovalItem,
  AgentJournalItemBody,
  AgentJournalPromptOption,
  AgentJournalQuestion,
  AgentJournalQuestionItem
} from '../../../shared/agent-session-journal-types'
import {
  boundInlineText,
  boundPayload,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from './journal-payload-bounds'

export const MAX_JOURNAL_PROMPT_OPTIONS = 64
export const MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS = 4
export const MAX_JOURNAL_GROUPED_PROMPT_OPTIONS = 8
export const MAX_CANCELLED_JOURNAL_PROMPT_BODY_BYTES = 256 * 1024

const JOURNAL_PROMPT_TEXT_LIMITS = { inlineHeadBytes: 4 * 1024 }
const JOURNAL_PROMPT_OPTION_LIMITS = { inlineHeadBytes: 512 }
const JOURNAL_PROMPT_ID_MAX_BYTES = 512

export function cancelledJournalPromptBody(
  body: AgentJournalItemBody,
  resolution: {
    resolvedBy?: string | null
    resolvedAt?: number | null
    settlementId?: string
  } = {}
): AgentJournalApprovalItem | AgentJournalQuestionItem | null {
  if (body.kind !== 'approval' && body.kind !== 'question') {
    return null
  }
  const bounded = boundJournalPromptBody(body)
  const cancelled = {
    ...bounded,
    resolution: {
      state: 'cancelled' as const,
      selectedOptionId: null,
      resolvedBy: resolution.resolvedBy ?? null,
      resolvedAt: resolution.resolvedAt ?? null,
      ...(resolution.settlementId ? { settlementId: resolution.settlementId } : {})
    }
  }
  if (
    Buffer.byteLength(JSON.stringify(cancelled), 'utf8') <= MAX_CANCELLED_JOURNAL_PROMPT_BODY_BYTES
  ) {
    return cancelled
  }
  return cancelled.kind === 'approval'
    ? { ...cancelled, detail: null, options: [] }
    : {
        kind: 'question',
        question: cancelled.question,
        options: [],
        resolution: cancelled.resolution
      }
}

export function boundJournalStatusText(text: string): string {
  return boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
}

function boundJournalPromptBody(
  body: AgentJournalApprovalItem | AgentJournalQuestionItem
): AgentJournalApprovalItem | AgentJournalQuestionItem {
  if (body.kind === 'approval') {
    return {
      ...body,
      title: boundPromptText(body.title),
      detail: body.detail === null ? null : boundPromptText(body.detail),
      options: boundPromptOptions(body.options)
    }
  }
  return {
    ...body,
    question: boundPromptText(body.question),
    options: boundPromptOptions(body.options),
    ...(body.questions ? { questions: boundPromptQuestions(body.questions) } : {}),
    ...(body.freeTextQuestionId
      ? { freeTextQuestionId: boundPromptIdentifier(body.freeTextQuestionId) }
      : {})
  }
}

function boundPromptOptions(
  options: readonly AgentJournalPromptOption[],
  maxOptions = MAX_JOURNAL_PROMPT_OPTIONS
): AgentJournalPromptOption[] {
  return options.slice(0, maxOptions).map((option) => ({
    id: boundPromptIdentifier(option.id),
    label: boundInlineText(option.label, JOURNAL_PROMPT_OPTION_LIMITS).text,
    ...(option.description
      ? { description: boundInlineText(option.description, JOURNAL_PROMPT_OPTION_LIMITS).text }
      : {})
  }))
}

function boundPromptQuestions(questions: readonly AgentJournalQuestion[]): AgentJournalQuestion[] {
  return questions.slice(0, MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS).map((question) => ({
    id: boundPromptIdentifier(question.id),
    question: boundPromptText(question.question),
    ...(question.header ? { header: boundPromptText(question.header) } : {}),
    multiSelect: question.multiSelect,
    options: boundPromptOptions(question.options, MAX_JOURNAL_GROUPED_PROMPT_OPTIONS),
    ...(question.freeTextQuestionId
      ? { freeTextQuestionId: boundPromptIdentifier(question.freeTextQuestionId) }
      : {})
  }))
}

function boundPromptText(value: string): string {
  return boundInlineText(value, JOURNAL_PROMPT_TEXT_LIMITS).text
}

function boundPromptIdentifier(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= JOURNAL_PROMPT_ID_MAX_BYTES) {
    return value
  }
  const bounded = boundPayload(value, { inlineHeadBytes: JOURNAL_PROMPT_ID_MAX_BYTES - 33 })
  return `${bounded.head}#${bounded.digest.slice(0, 32)}`
}
