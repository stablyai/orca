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
  DEFAULT_JOURNAL_PAYLOAD_LIMITS,
  NO_PAYLOAD_RETENTION
} from './journal-payload-bounds'

export const MAX_JOURNAL_PROMPT_OPTIONS = 64
export const MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS = 4

const JOURNAL_PROMPT_OPTION_LIMITS = { inlineHeadBytes: 1024 }
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

/** Status text, clipped for the row. Only the string survives, so the original
 *  is not retained: no row would reference it and no reader could serve it. */
export function boundJournalStatusText(text: string): string {
  return boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS, NO_PAYLOAD_RETENTION).text
}

export function boundJournalPromptBody(body: AgentJournalApprovalItem): AgentJournalApprovalItem
export function boundJournalPromptBody(body: AgentJournalQuestionItem): AgentJournalQuestionItem
export function boundJournalPromptBody(
  body: AgentJournalApprovalItem | AgentJournalQuestionItem
): AgentJournalApprovalItem | AgentJournalQuestionItem
export function boundJournalPromptBody(
  body: AgentJournalApprovalItem | AgentJournalQuestionItem
): AgentJournalApprovalItem | AgentJournalQuestionItem {
  if (body.kind === 'approval') {
    return {
      ...body,
      title: boundPromptText(body.title),
      ...(body.displayName === undefined ? {} : { displayName: boundPromptText(body.displayName) }),
      ...(body.description === undefined ? {} : { description: boundPromptText(body.description) }),
      ...(body.decisionReason === undefined
        ? {}
        : { decisionReason: boundPromptText(body.decisionReason) }),
      ...(body.blockedPath === undefined ? {} : { blockedPath: boundPromptText(body.blockedPath) }),
      ...(body.matchedAskRule === undefined
        ? {}
        : {
            matchedAskRule: {
              source: boundPromptText(body.matchedAskRule.source),
              toolName: boundPromptText(body.matchedAskRule.toolName),
              ...(body.matchedAskRule.ruleContent === undefined
                ? {}
                : { ruleContent: boundPromptText(body.matchedAskRule.ruleContent) })
            }
          }),
      ...(body.subject === undefined
        ? {}
        : {
            subject: {
              kind: 'plan',
              text: boundPromptText(body.subject.text),
              ...(body.subject.filePath === undefined
                ? {}
                : { filePath: boundPromptText(body.subject.filePath) })
            }
          }),
      detail: body.detail === null ? null : boundPromptText(body.detail),
      options: boundPromptOptions(body.options)
    }
  }
  return {
    ...body,
    question: boundPromptText(body.question),
    options: boundPromptOptions(body.options),
    ...(body.questions
      ? {
          questions: body.questions
            .slice(0, MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS)
            .map(boundPromptQuestion)
        }
      : {}),
    ...(body.freeTextQuestionId
      ? { freeTextQuestionId: boundPromptIdentifier(body.freeTextQuestionId) }
      : {})
  }
}

function boundPromptQuestion(question: AgentJournalQuestion): AgentJournalQuestion {
  return {
    id: boundPromptIdentifier(question.id),
    question: boundPromptText(question.question),
    ...(question.header === undefined ? {} : { header: boundPromptText(question.header) }),
    multiSelect: question.multiSelect,
    options: boundPromptOptions(question.options),
    ...(question.freeTextQuestionId
      ? { freeTextQuestionId: boundPromptIdentifier(question.freeTextQuestionId) }
      : {})
  }
}

/** The prompt's options, capped in count and each clipped to the per-option
 *  bound. Ids are digest-suffixed rather than truncated so two options cannot
 *  merge into one. */
function boundPromptOptions(
  options: readonly AgentJournalPromptOption[]
): AgentJournalPromptOption[] {
  return options.slice(0, MAX_JOURNAL_PROMPT_OPTIONS).map((option) => ({
    id: boundPromptIdentifier(option.id),
    label: boundInlineText(option.label, JOURNAL_PROMPT_OPTION_LIMITS, NO_PAYLOAD_RETENTION).text,
    ...(option.description === undefined
      ? {}
      : {
          description: boundInlineText(
            option.description,
            JOURNAL_PROMPT_OPTION_LIMITS,
            NO_PAYLOAD_RETENTION
          ).text
        })
  }))
}

/** Prompt text, clipped for the row; the original is never retained. */
function boundPromptText(value: string): string {
  return boundInlineText(value, DEFAULT_JOURNAL_PAYLOAD_LIMITS, NO_PAYLOAD_RETENTION).text
}

/** An over-long identifier, clipped and suffixed with a digest so two distinct
 *  prompts cannot collide on a shared prefix. The digest is an identity, not a
 *  reference, so the original text is not retained. */
function boundPromptIdentifier(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= JOURNAL_PROMPT_ID_MAX_BYTES) {
    return value
  }
  const bounded = boundPayload(
    value,
    { inlineHeadBytes: JOURNAL_PROMPT_ID_MAX_BYTES - 33 },
    NO_PAYLOAD_RETENTION
  )
  return `${bounded.head}#${bounded.digest.slice(0, 32)}`
}
