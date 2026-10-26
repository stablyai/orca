import type { AgentJournalQuestion } from '../../../src/shared/agent-session-journal-types'
import {
  isValidAgentSessionQuestionAnswers,
  type AgentSessionQuestionAnswer
} from '../../../src/shared/agent-session-question-answer'
import type { MobileChatQuestion } from './mobile-native-chat-question'

// Grouped prompts put content in questions and leave flat options empty; collect steps locally and submit the whole answer set once.
export type GroupedQuestionDraft = {
  /** Identifies the exact prompt revision these answers belong to; a revised prompt discards them. */
  promptKey: string
  answers: AgentSessionQuestionAnswer[]
}

export type GroupedQuestionAdvance =
  | { kind: 'advance'; draft: GroupedQuestionDraft }
  | { kind: 'submit'; answers: AgentSessionQuestionAnswer[] }

const GROUPED_TOKEN_PREFIX = 'structured-grouped-question:'

type GroupedTokenPayload =
  | { kind: 'option'; promptKey: string; questionId: string; optionId: string }
  | { kind: 'free-text'; promptKey: string; questionId: string }

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
    if (typeof decoded.promptKey !== 'string' || typeof decoded.questionId !== 'string') {
      return null
    }
    if (decoded.kind === 'option' && typeof decoded.optionId === 'string') {
      return {
        kind: 'option',
        promptKey: decoded.promptKey,
        questionId: decoded.questionId,
        optionId: decoded.optionId
      }
    }
    if (decoded.kind === 'free-text') {
      return { kind: 'free-text', promptKey: decoded.promptKey, questionId: decoded.questionId }
    }
  } catch {
    return null
  }
  return null
}

function decodeGroupedFreeTextAnswer(value: string): {
  promptKey: string
  questionId: string
  answer: string
} | null {
  if (!value.startsWith(GROUPED_TOKEN_PREFIX)) {
    return null
  }
  // The payload is percent-encoded, so the first `:` after the prefix is the answer separator.
  const separator = value.indexOf(':', GROUPED_TOKEN_PREFIX.length)
  if (separator === -1) {
    return null
  }
  const payload = decodeGroupedToken(value.slice(0, separator))
  if (payload?.kind !== 'free-text') {
    return null
  }
  try {
    return {
      promptKey: payload.promptKey,
      questionId: payload.questionId,
      answer: decodeURIComponent(value.slice(separator + 1))
    }
  } catch {
    return null
  }
}

function answersFor(
  draft: GroupedQuestionDraft | null,
  promptKey: string
): AgentSessionQuestionAnswer[] {
  return draft && draft.promptKey === promptKey ? draft.answers : []
}

export function projectGroupedQuestion(
  questions: readonly AgentJournalQuestion[],
  draft: GroupedQuestionDraft | null,
  promptKey: string,
  promptIdentity?: { itemId: string; expectedRevision: number }
): MobileChatQuestion | null {
  const answered = answersFor(draft, promptKey).length
  const question = questions[answered]
  if (!question) {
    return null
  }
  const heading = question.header ? `${question.header}: ${question.question}` : question.question
  const optionDescriptions = question.options.map((option) => option.description)
  return {
    question:
      questions.length > 1 ? `${heading} (${answered + 1} of ${questions.length})` : heading,
    ...(promptIdentity ? { prompt: promptIdentity } : {}),
    options: question.options.map((option) => option.label),
    ...(optionDescriptions.some(Boolean) ? { optionDescriptions } : {}),
    multiSelect: question.multiSelect,
    allowOther: Boolean(question.freeTextQuestionId),
    ...(question.freeTextInput ? { freeTextInput: question.freeTextInput } : {}),
    optionTokens: question.options.map((option) =>
      encodeGroupedToken({
        kind: 'option',
        promptKey,
        questionId: question.id,
        optionId: option.id
      })
    ),
    ...(question.freeTextQuestionId
      ? {
          freeTextToken: encodeGroupedToken({
            kind: 'free-text',
            promptKey,
            questionId: question.id
          })
        }
      : {})
  }
}

function answerFromResponse(
  response: string,
  question: AgentJournalQuestion,
  promptKey: string
): AgentSessionQuestionAnswer | null {
  // Multi-select submits comma-joined parts; tokens and free text are encoded, so the separator is stable.
  const optionIds: string[] = []
  let other: string | undefined
  for (const part of response.split(', ')) {
    const trimmed = part.trim()
    const freeText = decodeGroupedFreeTextAnswer(trimmed)
    if (freeText) {
      const allowEmpty = question.freeTextInput?.allowEmpty === true
      const answer = allowEmpty ? freeText.answer : freeText.answer.trim()
      if (
        freeText.promptKey !== promptKey ||
        freeText.questionId !== question.id ||
        (answer.length === 0 && !allowEmpty) ||
        other !== undefined
      ) {
        return null
      }
      other = answer
      continue
    }

    const payload = decodeGroupedToken(trimmed)
    if (
      payload?.kind !== 'option' ||
      payload.promptKey !== promptKey ||
      payload.questionId !== question.id
    ) {
      return null
    }
    optionIds.push(payload.optionId)
  }
  const offered = new Set(question.options.map((option) => option.id))
  if (optionIds.some((optionId) => !offered.has(optionId))) {
    return null
  }
  if (other !== undefined && !question.freeTextQuestionId) {
    return null
  }
  const answerCount = optionIds.length + (other !== undefined ? 1 : 0)
  if (answerCount === 0 || (!question.multiSelect && answerCount !== 1)) {
    return null
  }
  return { questionId: question.id, optionIds, ...(other !== undefined ? { other } : {}) }
}

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
  const answer = answerFromResponse(args.response, question, args.promptKey)
  if (!answer) {
    return null
  }
  const answers = [...collected, answer]
  if (answers.length < args.questions.length) {
    return { kind: 'advance', draft: { promptKey: args.promptKey, answers } }
  }
  // Validate before submission so an unanswerable refusal cannot strand the group.
  return isValidAgentSessionQuestionAnswers(args.questions, answers)
    ? { kind: 'submit', answers }
    : null
}
