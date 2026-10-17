import type {
  NativeChatAsyncQuestion,
  NativeChatTextBlock,
  NativeChatBlock
} from '../../shared/native-chat-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import { readRecord, readString } from './codex-item-field-readers'

/** Builds a question card with a text fallback; oversized questions remain text-only. */
export function codexAsyncQuestionBlock(value: unknown): NativeChatTextBlock | null {
  if (!Array.isArray(value)) {
    return null
  }
  const questions: NativeChatAsyncQuestion[] = []
  for (const entry of value) {
    const question = readRecord(entry)
    const title = readString(question, 'title')
    if (!title?.trim()) {
      continue
    }
    const options = Array.isArray(question.options)
      ? question.options.filter((option): option is string => typeof option === 'string')
      : []
    questions.push({ title, options })
  }
  if (questions.length === 0) {
    return null
  }
  const text = questions
    .map(({ title, options }) =>
      [title, ...options.map((option, index) => `${index + 1}. ${option}`)].join('\n')
    )
    .join('\n\n')
  // An oversized question stays readable, but never offers clipped choices as complete answers.
  const interactive =
    Buffer.byteLength(JSON.stringify(questions), 'utf8') <=
    DEFAULT_JOURNAL_PAYLOAD_LIMITS.inlineHeadBytes
  return {
    type: 'text',
    text: boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text,
    ...(interactive ? { asyncQuestions: questions } : {})
  }
}

/** Adds the question card and removes duplicate question text, keeping any extra prose. */
export function codexAsyncMessageBlocks(
  blocks: NativeChatBlock[],
  value: unknown,
  providerItemId?: string | null
): NativeChatBlock[] {
  const questionBlock = codexAsyncQuestionBlock(value)
  if (!questionBlock) {
    return blocks
  }
  const prose = questionBlock.asyncQuestions
    ?.map(({ title, options }) => [title, ...options.map((option) => `- ${option}`)].join('\n'))
    .join('\n\n')
  return [
    ...blocks.filter(
      (block) =>
        block.type !== 'text' ||
        (block.text.trim() !== prose && block.text.trim() !== questionBlock.text.trim())
    ),
    { ...questionBlock, ...(providerItemId ? { asyncQuestionId: providerItemId } : {}) }
  ]
}
