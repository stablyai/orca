import { nativeChatAskDismissKey, type AskPrompt } from '../../../src/shared/native-chat-ask'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

export type MobileAsyncAskPrompt = AskPrompt & { asyncCallIds: string[] }

export function isMobileAsyncAsk(prompt: AskPrompt | null): prompt is MobileAsyncAskPrompt {
  return prompt !== null && 'asyncCallIds' in prompt
}

export function mobileNativeChatAskKey(prompt: AskPrompt | null): string | null {
  return isMobileAsyncAsk(prompt)
    ? `async:${JSON.stringify(prompt.asyncCallIds)}:${nativeChatAskDismissKey(prompt)}`
    : nativeChatAskDismissKey(prompt)
}

function parseAsyncQuestions(input: unknown): AskPrompt['questions'] | null {
  try {
    const parsed = typeof input === 'string' ? JSON.parse(input) : input
    if (!parsed || !Array.isArray(parsed.questions) || parsed.questions.length === 0) {
      return null
    }
    const questions: AskPrompt['questions'] = []
    for (const question of parsed.questions) {
      if (!question || typeof question.title !== 'string' || !question.title.trim()) {
        return null
      }
      const options: unknown = question.options
      if (
        options !== undefined &&
        (!Array.isArray(options) ||
          options.length === 0 ||
          options.some((option) => typeof option !== 'string' || !option.trim()))
      ) {
        return null
      }
      questions.push({
        question: question.title,
        multiSelect: false,
        options: ((options ?? []) as string[]).map((label) => ({ label }))
      })
    }
    return questions
  } catch {
    return null
  }
}

/** Async acceptance is an assistant item with the call id, not a FIFO tool result. */
export function extractMobileAsyncAsk(
  messages: readonly NativeChatMessage[]
): MobileAsyncAskPrompt | null {
  const calls = new Map<string, AskPrompt['questions']>()
  const completed = new Set<string>()
  for (const message of messages) {
    if (message.role === 'user') {
      calls.clear()
      completed.clear()
    }
    if (message.role === 'assistant' && message.blocks.some((block) => block.type === 'text')) {
      completed.add(message.id)
    }
    for (const block of message.blocks) {
      if (
        block.type !== 'tool-call' ||
        block.name !== 'request_user_input_async' ||
        !block.callId
      ) {
        continue
      }
      const questions = parseAsyncQuestions(block.input)
      if (questions) {
        calls.set(block.callId, questions)
      }
    }
  }
  const pending = [...calls].filter(([id]) => completed.has(id))
  return pending.length > 0
    ? {
        asyncCallIds: pending.map(([id]) => id),
        questions: pending.flatMap(([, questions]) => questions)
      }
    : null
}
