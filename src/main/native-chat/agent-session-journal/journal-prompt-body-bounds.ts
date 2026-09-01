import type {
  AgentJournalApprovalItem,
  AgentJournalItemBody,
  AgentJournalPromptOption,
  AgentJournalQuestionItem
} from '../../../shared/agent-session-journal-types'
import {
  boundInlineText,
  boundPayload,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from './journal-payload-bounds'

export const MAX_JOURNAL_PROMPT_OPTIONS = 64

const JOURNAL_PROMPT_OPTION_LIMITS = {
  ...DEFAULT_JOURNAL_PAYLOAD_LIMITS,
  inlineHeadBytes: 1024
}
const JOURNAL_PROMPT_ID_MAX_BYTES = 1024

export function cancelledJournalPromptBody(
  body: AgentJournalItemBody
): AgentJournalApprovalItem | AgentJournalQuestionItem | null {
  if (body.kind !== 'approval' && body.kind !== 'question') {
    return null
  }
  const bounded = boundJournalPromptBody(body)
  return {
    ...bounded,
    resolution: {
      state: 'cancelled',
      selectedOptionId: null,
      resolvedBy: null,
      resolvedAt: null
    }
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
    ...(body.freeTextQuestionId
      ? { freeTextQuestionId: boundPromptIdentifier(body.freeTextQuestionId) }
      : {})
  }
}

function boundPromptOptions(
  options: readonly AgentJournalPromptOption[]
): AgentJournalPromptOption[] {
  return options.slice(0, MAX_JOURNAL_PROMPT_OPTIONS).map((option) => ({
    id: boundPromptIdentifier(option.id),
    label: boundInlineText(option.label, JOURNAL_PROMPT_OPTION_LIMITS).text
  }))
}

function boundPromptText(value: string): string {
  return boundInlineText(value, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
}

function boundPromptIdentifier(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= JOURNAL_PROMPT_ID_MAX_BYTES) {
    return value
  }
  const bounded = boundPayload(value, {
    inlineHeadBytes: JOURNAL_PROMPT_ID_MAX_BYTES - 33,
    maxSessionBytes: Number.MAX_SAFE_INTEGER,
    maxAppendsPerWindow: Number.MAX_SAFE_INTEGER,
    appendWindowMs: Number.MAX_SAFE_INTEGER
  })
  return `${bounded.head}#${bounded.digest.slice(0, 32)}`
}
