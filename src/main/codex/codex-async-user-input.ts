// Codex 0.158+ `request_user_input_async`: the question arrives as an async `agentMessage`
// carrying `questions`, with no server request, and the next user message answers it.

import { readRecord, readString, readTextContent } from './codex-item-field-readers'
import type { CodexPendingPrompt } from './codex-prompt-registry'
import { readCodexThreadItem } from './codex-thread-item-identity'
import { readCodexTurnId } from './codex-structured-thread-facts'

/** An async ask, reshaped as the `item/tool/requestUserInput` params the prompt path reads. */
export type CodexAsyncQuestionRequest = {
  itemId: string
  params: Record<string, unknown>
}

/** Null for anything but a completed async agent message that asks at least one question. */
export function readCodexAsyncQuestionRequest(
  threadId: string,
  method: string,
  params: unknown
): CodexAsyncQuestionRequest | null {
  if (method !== 'item/completed') {
    return null
  }
  const item = readCodexThreadItem(readRecord(params).item)
  if (!item || item.type !== 'agentMessage' || item.delivery !== 'async') {
    return null
  }
  const questions: Record<string, unknown>[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(item.questions) ? item.questions : []) {
    const question = readRecord(entry)
    const title = readString(question, 'title')
    // The title doubles as the question id, so the steered reply can name what it answers.
    if (!title || seen.has(title)) {
      continue
    }
    seen.add(title)
    const labels = Array.isArray(question.options)
      ? question.options.filter(
          (option): option is string => typeof option === 'string' && option.length > 0
        )
      : []
    questions.push({
      id: title,
      question: title,
      // Any user message answers an async ask, so the card always takes free text too.
      options: [...labels.map((label) => ({ label })), { label: 'Other', isOther: true }]
    })
  }
  if (questions.length === 0) {
    return null
  }
  const turnId = readCodexTurnId(params)
  return {
    itemId: item.id,
    params: { threadId, itemId: item.id, ...(turnId ? { turnId } : {}), questions }
  }
}

/** The steered user message for a fully answered async ask. */
export function codexAsyncAnswerText(prompt: CodexPendingPrompt): string {
  if (prompt.questionIds.length === 1) {
    return prompt.answers.get(prompt.questionIds[0]!) ?? ''
  }
  return prompt.questionIds.map((id) => `${id}: ${prompt.answers.get(id) ?? ''}`).join('\n')
}

/** Card answers a typed reply overtook before the ask was complete; null when there are none. */
export function codexAsyncPartialAnswerText(prompt: CodexPendingPrompt): string | null {
  const lines = prompt.questionIds.flatMap((id) => {
    const answer = prompt.answers.get(id)
    return answer === undefined ? [] : [`${id}: ${answer}`]
  })
  return lines.length > 0 ? lines.join('\n') : null
}

/** A live user message, which answers every async ask still open on its thread; null otherwise. */
export function readCodexUserMessageReply(
  method: string,
  params: unknown
): { text: string | null } | null {
  if (method !== 'item/started' && method !== 'item/completed') {
    return null
  }
  const item = readCodexThreadItem(readRecord(params).item)
  if (!item || item.type !== 'userMessage') {
    return null
  }
  return { text: readTextContent(item, 'content') ?? readString(item, 'text') }
}
