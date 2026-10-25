// Parse terminal choice text conservatively so ordinary prose cannot become an actionable question.

import type { AgentJournalFreeTextInput } from '../../../src/shared/agent-session-journal-types'

export type MobileChatQuestion = {
  question: string
  /** Structured prompt identity, present only for durable host prompts. */
  prompt?: { itemId: string; expectedRevision: number }
  options: string[]
  multiSelect: boolean
  /** Structured questions hide the free-text row when the provider does not accept it. */
  allowOther?: boolean
  // Preserve listed number/letter tokens for exact TUI responses; bullets have no token.
  optionTokens: (string | null)[]
  optionDescriptions?: (string | undefined)[]
  /** Opaque prefix used when free-text answers must target a specific prompt. */
  freeTextToken?: string
  freeTextInput?: AgentJournalFreeTextInput
}

export function mobileChatQuestionKey(question: MobileChatQuestion): string {
  return JSON.stringify(question)
}

type ParsedOption = {
  label: string
  token: string | null
}

const POINTER_PREFIX = /^(\s*)(?:❯|›|»)\s+/

// Match specific numbered/lettered forms before generic bullets; record token and label capture indexes.
const OPTION_PATTERNS: { re: RegExp; token: number; label: number }[] = [
  { re: /^\s*(\d{1,2})[.)]\s+(\S.*?)\s*$/, token: 1, label: 2 },
  { re: /^\s*\[([0-9a-zA-Z])\]\s+(\S.*?)\s*$/, token: 1, label: 2 },
  // Single letters avoid treating prose such as e.g. as an option.
  { re: /^\s*([a-zA-Z])[.)]\s+(\S.*?)\s*$/, token: 1, label: 2 },
  { re: /^\s*(?:[-*•>])\s+(\S.*?)\s*$/, token: 0, label: 1 }
]

function parseOptionLine(line: string): ParsedOption | null {
  const stripped = line.replace(POINTER_PREFIX, '$1')
  for (const { re, token, label } of OPTION_PATTERNS) {
    const m = stripped.match(re)
    if (!m) {
      continue
    }
    const text = m[label].trim()
    if (text.length === 0) {
      continue
    }
    return { label: text, token: token > 0 ? m[token] : null }
  }
  return null
}

const MULTI_SELECT_HINT =
  /\b(select all|choose all|choose multiple|select multiple|pick multiple|all that apply|one or more|comma[- ]separated|multiple options)\b/i

const QUESTION_LINE = /[?:]\s*$/

function cleanQuestionText(raw: string): string {
  const trimmed = raw.trim()
  return trimmed.endsWith(':') ? trimmed.slice(0, -1).trim() : trimmed
}

// Require a clear option list: at least two entries or one introduced by a question-like line.
export function parseAgentQuestion(text: string): MobileChatQuestion | null {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return null
  }

  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const parsed: { index: number; option: ParsedOption }[] = []

  lines.forEach((line, index) => {
    const option = parseOptionLine(line)
    if (option) {
      parsed.push({ index, option })
    }
  })

  if (parsed.length === 0) {
    return null
  }

  const firstOptionIndex = parsed[0].index
  const options = parsed.map((p) => p.option.label)
  const optionTokens = parsed.map((p) => p.option.token)

  let question = ''
  let questionLooksLikePrompt = false
  for (let i = firstOptionIndex - 1; i >= 0; i--) {
    if (lines[i].trim().length === 0 || parseOptionLine(lines[i])) {
      continue
    }
    question = lines[i]
    questionLooksLikePrompt = QUESTION_LINE.test(lines[i])
    break
  }

  if (options.length < 2 && !questionLooksLikePrompt) {
    return null
  }

  const multiSelect = MULTI_SELECT_HINT.test(text) && options.length > 1

  return {
    question: question.length > 0 ? cleanQuestionText(question) : 'Choose an option',
    options,
    multiSelect,
    optionTokens
  }
}

function formatQuestionOptionAtIndex(question: MobileChatQuestion, index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index >= question.options.length) {
    return null
  }
  const label = question.options[index]
  if (label == null || label.trim().length === 0) {
    return null
  }
  const token = question.optionTokens[index]
  return token != null && token.length > 0 ? token : label
}

function formatQuestionAnswerPartsByIndexes(
  question: MobileChatQuestion,
  selectedIndexes: number[]
): string[] {
  return selectedIndexes
    .map((index) => formatQuestionOptionAtIndex(question, index))
    .filter((part): part is string => part != null && part.trim().length > 0)
}

export function formatQuestionAnswerByIndexes(
  question: MobileChatQuestion,
  selectedIndexes: number[]
): string {
  const parts = formatQuestionAnswerPartsByIndexes(question, selectedIndexes)
  return parts.join(question.multiSelect ? ', ' : ' ')
}

export function formatQuestionAnswerWithOtherByIndexes(
  question: MobileChatQuestion,
  selectedIndexes: number[],
  text: string
): string {
  const parts = formatQuestionAnswerPartsByIndexes(question, selectedIndexes)
  const other = formatQuestionFreeTextAnswer(question, text)
  if (other.length > 0) {
    parts.push(other)
  }
  return parts.join(question.multiSelect ? ', ' : ' ')
}

// Send listed tokens when available, else labels; preserve unknown/free text and comma-join multi-select answers.
export function formatQuestionAnswer(question: MobileChatQuestion, selected: string[]): string {
  const labels = selected.map((s) => s.trim()).filter((s) => s.length > 0)
  if (labels.length === 0) {
    return ''
  }

  const parts = labels.map((label) => {
    const index = question.options.indexOf(label)
    if (index === -1) {
      return label
    }
    return formatQuestionOptionAtIndex(question, index) ?? label
  })

  return parts.join(question.multiSelect ? ', ' : ' ')
}

export function formatQuestionFreeTextAnswer(question: MobileChatQuestion, text: string): string {
  const answer = question.freeTextInput?.allowEmpty ? text : text.trim()
  if (answer.length === 0 && !question.freeTextInput?.allowEmpty) {
    return ''
  }
  return question.freeTextToken
    ? `${question.freeTextToken}:${encodeURIComponent(answer)}`
    : question.freeTextInput?.allowEmpty
      ? answer
      : formatQuestionAnswer(question, [answer])
}
