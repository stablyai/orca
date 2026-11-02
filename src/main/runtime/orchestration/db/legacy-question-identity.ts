import type { MessageRow } from '../types'

export function normalizeLegacyQuestionText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim()
}

export function normalizeLegacyQuestionOptions(options: unknown): string {
  if (!Array.isArray(options) || !options.every((option) => typeof option === 'string')) {
    return '[]'
  }
  return JSON.stringify(options.map((option) => option.trim()))
}

export function legacyMessageMatchesQuestion(
  message: MessageRow,
  question: string,
  options: string[],
  recipientHandles: readonly string[]
): boolean {
  if (
    !recipientHandles.includes(message.to_handle) ||
    normalizeLegacyQuestionText(message.body) !== normalizeLegacyQuestionText(question)
  ) {
    return false
  }
  try {
    const payload = JSON.parse(message.payload ?? '{}') as { options?: unknown }
    return (
      normalizeLegacyQuestionOptions(payload.options) === normalizeLegacyQuestionOptions(options)
    )
  } catch {
    return false
  }
}
