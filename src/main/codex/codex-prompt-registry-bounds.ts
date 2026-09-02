import {
  boundPayload,
  digestPayload
} from '../native-chat/agent-session-journal/journal-payload-bounds'

export const CODEX_JOURNAL_PROMPT_ID_COMPONENT_MAX_BYTES = 256
export const CODEX_JOURNAL_PROMPT_OPTION_ID_MAX_BYTES = 1024
export const CODEX_PROMPT_MAX_QUESTIONS = 64
export const CODEX_PROMPT_MAX_QUESTION_BYTES = 32 * 1024
export const CODEX_PROMPT_MAX_OPTIONS = 256
export const CODEX_PROMPT_MAX_OPTION_BYTES = 64 * 1024
export const CODEX_PROMPT_MAX_ANSWER_BYTES = 64 * 1024
export const MAX_CODEX_PROMPT_REGISTRY_ENTRIES = 128
export const MAX_CODEX_PROMPT_JOURNAL_BINDINGS = 256
export const MAX_CODEX_PROMPT_REGISTRY_BYTES = 4 * 1024 * 1024

export function codexJournalPromptIdPart(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= CODEX_JOURNAL_PROMPT_ID_COMPONENT_MAX_BYTES) {
    return value
  }
  const suffix = `#${digestPayload(value).slice(0, 32)}`
  const bounded = boundPayload(value, {
    inlineHeadBytes: CODEX_JOURNAL_PROMPT_ID_COMPONENT_MAX_BYTES - suffix.length,
    maxSessionBytes: Number.MAX_SAFE_INTEGER,
    maxAppendsPerWindow: Number.MAX_SAFE_INTEGER,
    appendWindowMs: Number.MAX_SAFE_INTEGER
  })
  return `${bounded.head}${suffix}`
}

export function encodeCodexJournalQuestionOptionId(questionId: string, answer: string): string {
  const exact = `${encodeURIComponent(questionId)}:${encodeURIComponent(answer)}`
  if (Buffer.byteLength(exact, 'utf8') <= CODEX_JOURNAL_PROMPT_OPTION_ID_MAX_BYTES) {
    return exact
  }
  const bounded = `${encodeURIComponent(codexJournalPromptIdPart(questionId))}:${encodeURIComponent(codexJournalPromptIdPart(answer))}`
  if (Buffer.byteLength(bounded, 'utf8') <= CODEX_JOURNAL_PROMPT_OPTION_ID_MAX_BYTES) {
    return bounded
  }
  return `#${digestPayload(questionId).slice(0, 32)}:#${digestPayload(answer).slice(0, 32)}`
}

export function readQuestionIds(params: unknown): string[] | null {
  const questions = (params as { questions?: unknown } | null)?.questions
  if (!Array.isArray(questions)) {
    return []
  }
  const ids: string[] = []
  let bytes = 0
  for (const question of questions) {
    const id = (question as { id?: unknown })?.id
    if (typeof id !== 'string' || id.length === 0) {
      continue
    }
    if (ids.length >= CODEX_PROMPT_MAX_QUESTIONS) {
      return null
    }
    bytes += Buffer.byteLength(id, 'utf8')
    if (bytes > CODEX_PROMPT_MAX_QUESTION_BYTES) {
      return null
    }
    ids.push(id)
  }
  return ids
}

export function readQuestionOptionAnswers(
  params: unknown
): Map<string, { questionId: string; answer: string }> | null {
  const questions = (params as { questions?: unknown } | null)?.questions
  const answers = new Map<string, { questionId: string; answer: string }>()
  if (!Array.isArray(questions)) {
    return answers
  }
  let optionCount = 0
  let optionBytes = 0
  for (const entry of questions) {
    const question = typeof entry === 'object' && entry !== null ? entry : {}
    const questionId = (question as { id?: unknown }).id
    const options = (question as { options?: unknown }).options
    if (typeof questionId !== 'string' || !Array.isArray(options)) {
      continue
    }
    for (const option of options) {
      const record = typeof option === 'object' && option !== null ? option : {}
      const label = (record as { label?: unknown }).label
      if (
        typeof label !== 'string' ||
        label.length === 0 ||
        (record as { isOther?: unknown }).isOther === true
      ) {
        continue
      }
      if (++optionCount > CODEX_PROMPT_MAX_OPTIONS) {
        return null
      }
      optionBytes += Buffer.byteLength(questionId, 'utf8') + Buffer.byteLength(label, 'utf8')
      if (optionBytes > CODEX_PROMPT_MAX_OPTION_BYTES) {
        return null
      }
      answers.set(encodeCodexJournalQuestionOptionId(questionId, label), {
        questionId,
        answer: label
      })
    }
  }
  return answers
}
