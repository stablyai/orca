import type { AgentJournalQuestion } from '../../../src/shared/agent-session-journal-types'
import {
  encodeAgentSessionQuestionAnswers,
  isValidAgentSessionQuestionAnswers,
  type AgentSessionQuestionAnswer
} from '../../../src/shared/agent-session-question-answer'
import type { MobileChatQuestion } from './mobile-native-chat-question'

/**
 * Claude's AskUserQuestion can carry several questions, or one multi-select question, in a single
 * prompt. The host then leaves the flat `question.options` EMPTY and puts the real content in
 * `questions`, so a client that reads only the flat shape renders an unanswerable card and the turn
 * stalls. The phone has room for one question at a time, so the group is answered as steps and
 * submitted once — the host accepts the whole group as one encoded option id.
 */
export type GroupedQuestionDraft = {
  /** Identifies the exact prompt revision these answers belong to; a revised prompt discards them. */
  promptKey: string
  answers: AgentSessionQuestionAnswer[]
}

export type GroupedQuestionAdvance =
  | { kind: 'advance'; draft: GroupedQuestionDraft }
  | { kind: 'submit'; optionId: string }

const GROUPED_TOKEN_PREFIX = 'structured-grouped-question:'

type GroupedTokenPayload =
  | { kind: 'option'; questionId: string; optionId: string }
  | { kind: 'free-text'; questionId: string }

export function groupedQuestionPromptKey(itemId: string, revision: number): string {
  return `${itemId}:${revision}`
}

function encodeGroupedToken(payload: GroupedTokenPayload): string {
  return `${GROUPED_TOKEN_PREFIX}${encodeURIComponent(JSON.stringify(payload))}`
}

function decodeGroupedToken(value: string): GroupedTokenPayload | null {
  if (!value.startsWith(GROUPED_TOKEN_PREFIX)) {
    return null
  }
  try {
    const decoded = JSON.parse(
      decodeURIComponent(value.slice(GROUPED_TOKEN_PREFIX.length))
    ) as Record<string, unknown>
    if (typeof decoded.questionId !== 'string') {
      return null
    }
    if (decoded.kind === 'option' && typeof decoded.optionId === 'string') {
      return { kind: 'option', questionId: decoded.questionId, optionId: decoded.optionId }
    }
    if (decoded.kind === 'free-text') {
      return { kind: 'free-text', questionId: decoded.questionId }
    }
  } catch {
    return null
  }
  return null
}

function decodeGroupedFreeTextAnswer(value: string): { questionId: string; answer: string } | null {
  if (!value.startsWith(GROUPED_TOKEN_PREFIX)) {
    return null
  }
  // The payload is percent-encoded, so the first `:` after the prefix is the answer separator.
  const separator = value.indexOf(':', GROUPED_TOKEN_PREFIX.length)
  if (separator === -1) {
    return null
  }
  const payload = decodeGroupedToken(value.slice(0, separator))
  return payload?.kind === 'free-text'
    ? { questionId: payload.questionId, answer: decodeURIComponent(value.slice(separator + 1)) }
    : null
}

/** Answers already collected for this exact prompt revision; a stale draft counts as none. */
function answersFor(
  draft: GroupedQuestionDraft | null,
  promptKey: string
): AgentSessionQuestionAnswer[] {
  return draft && draft.promptKey === promptKey ? draft.answers : []
}

/** The step to show now, or null once every question has an answer. */
export function projectGroupedQuestion(
  questions: readonly AgentJournalQuestion[],
  draft: GroupedQuestionDraft | null,
  promptKey: string
): MobileChatQuestion | null {
  const answered = answersFor(draft, promptKey).length
  const question = questions[answered]
  if (!question) {
    return null
  }
  const heading = question.header ? `${question.header}: ${question.question}` : question.question
  return {
    question:
      questions.length > 1 ? `${heading} (${answered + 1} of ${questions.length})` : heading,
    options: question.options.map((option) => option.label),
    multiSelect: question.multiSelect,
    allowOther: Boolean(question.freeTextQuestionId),
    optionTokens: question.options.map((option) =>
      encodeGroupedToken({ kind: 'option', questionId: question.id, optionId: option.id })
    ),
    ...(question.freeTextQuestionId
      ? { freeTextToken: encodeGroupedToken({ kind: 'free-text', questionId: question.id }) }
      : {})
  }
}

/** Read one step's answer out of what the question card sent back. */
function answerFromResponse(
  response: string,
  question: AgentJournalQuestion
): AgentSessionQuestionAnswer | null {
  const freeText = decodeGroupedFreeTextAnswer(response)
  if (freeText) {
    const other = freeText.answer.trim()
    return freeText.questionId === question.id && other
      ? { questionId: question.id, optionIds: [], other }
      : null
  }
  // Multi-select submits the selected option tokens as one comma-joined string; option tokens are
  // percent-encoded, so no token can contain the separator.
  const optionIds = response
    .split(', ')
    .map((part) => decodeGroupedToken(part.trim()))
    .flatMap((payload) =>
      payload?.kind === 'option' && payload.questionId === question.id ? [payload.optionId] : []
    )
  const offered = new Set(question.options.map((option) => option.id))
  return optionIds.length > 0 && optionIds.every((optionId) => offered.has(optionId))
    ? { questionId: question.id, optionIds }
    : null
}

/**
 * Fold one answer into the draft. Returns `advance` while questions remain and `submit` with the
 * encoded group once the last one lands; null when the response does not answer the current step,
 * so the caller can fall through to the flat single-question path.
 */
export function advanceGroupedQuestion(args: {
  response: string
  questions: readonly AgentJournalQuestion[]
  draft: GroupedQuestionDraft | null
  promptKey: string
}): GroupedQuestionAdvance | null {
  const collected = answersFor(args.draft, args.promptKey)
  const question = args.questions[collected.length]
  if (!question) {
    return null
  }
  const answer = answerFromResponse(args.response, question)
  if (!answer) {
    return null
  }
  const answers = [...collected, answer]
  if (answers.length < args.questions.length) {
    return { kind: 'advance', draft: { promptKey: args.promptKey, answers } }
  }
  // Never send a group the host would refuse — the user would see a silent failure with no way back.
  return isValidAgentSessionQuestionAnswers(args.questions, answers)
    ? { kind: 'submit', optionId: encodeAgentSessionQuestionAnswers(answers) }
    : null
}
