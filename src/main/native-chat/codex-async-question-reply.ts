// Codex's own reply envelope for async questions, recorded when a terminal user answers one
// question in Codex's question editor. Mirrors Codex's parser: only a complete envelope, after
// an optional IDE-context prefix, counts; anything else is an ordinary prompt.

import { asRecord } from '../ai-vault/session-scanner-values'

const REPLY_OPEN = '<send_user_message_question_reply>'
const REPLY_CLOSE = '</send_user_message_question_reply>'
const IDE_CONTEXT_PREFIX = '# Context from my IDE setup:\n'
const IDE_REQUEST_HEADING = '\n## My request for Codex:\n'

function replyQuestionId(value: unknown): string | null {
  const reply = asRecord(value)
  return reply &&
    typeof reply.questionItemId === 'string' &&
    typeof reply.question === 'string' &&
    typeof reply.answer === 'string'
    ? reply.questionItemId
    : null
}

/** The question ids a reply envelope answers, or null when `text` is not one. */
export function parseCodexAsyncQuestionReplyIds(rawText: string): string[] | null {
  let text = rawText.trim()
  if (text.startsWith(IDE_CONTEXT_PREFIX)) {
    const headingAt = text.lastIndexOf(IDE_REQUEST_HEADING)
    if (headingAt === -1) {
      return null
    }
    text = text.slice(headingAt + IDE_REQUEST_HEADING.length).trim()
  }
  if (!text.startsWith(REPLY_OPEN) || !text.endsWith(REPLY_CLOSE)) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(REPLY_OPEN.length, text.length - REPLY_CLOSE.length))
  } catch {
    return null
  }
  const replies = Array.isArray(parsed) ? parsed : [parsed]
  const ids = replies.map(replyQuestionId)
  return ids.length > 0 && ids.every((id) => id !== null) ? ids.filter((id) => id !== null) : null
}

/** The reply text of a user-message record: the legacy event's flattened `message`, or the
 *  item's single text input (skills and mentions aside), as Codex reads it. */
export function codexUserRecordReplyText(payload: Record<string, unknown>): string | null {
  if (payload.type === 'user_message') {
    return typeof payload.message === 'string' ? payload.message : null
  }
  const content = asRecord(payload.item)?.content
  if (!Array.isArray(content)) {
    return null
  }
  const inputs = content.filter((input) => {
    const type = asRecord(input)?.type
    return type !== 'skill' && type !== 'mention'
  })
  const [first] = inputs
  const record = asRecord(first)
  return inputs.length === 1 && record?.type === 'text' && typeof record.text === 'string'
    ? record.text
    : null
}
