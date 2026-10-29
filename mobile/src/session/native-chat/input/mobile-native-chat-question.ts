import type {
  AgentJournalFreeTextInput,
  AgentJournalQuestion
} from '../../../../../src/shared/agent-session-journal-types'

export type MobileChatQuestion = {
  question: string
  /** Structured prompt identity, present only for durable host prompts. */
  prompt?: { itemId: string; expectedRevision: number }
  options: string[]
  multiSelect: boolean
  /** Structured questions hide the free-text row when the provider does not accept it. */
  allowOther?: boolean
  // The answer each option sends; a null token sends its label.
  optionTokens: (string | null)[]
  optionDescriptions?: (string | undefined)[]
  /** Opaque prefix used when free-text answers must target a specific prompt. */
  freeTextToken?: string
  freeTextInput?: AgentJournalFreeTextInput
  /** A grouped structured prompt, answered on the stepped ask card. */
  questions?: readonly AgentJournalQuestion[]
}

export function mobileChatQuestionKey(question: MobileChatQuestion): string {
  return JSON.stringify(question)
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
