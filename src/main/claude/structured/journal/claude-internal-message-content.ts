import { asRecord } from '../../../ai-vault/session-scanner-record-value'
import type { ClaudeJournalTranslator } from './claude-journal-translator-contract'

export function withClaudeConversationContent(
  handle: ClaudeJournalTranslator['handle']
): ClaudeJournalTranslator['handle'] {
  return (event) => {
    if (event.type === 'message') {
      const message = claudeMessageWithoutSyntheticText(event.message)
      if (!message) {
        return
      }
      event = { ...event, message }
    }
    handle(event)
  }
}

export function isClaudeInjectedUserMessage(frame: Record<string, unknown>): boolean {
  return (
    frame.type === 'user' &&
    (frame.isMeta === true ||
      frame.isSynthetic === true ||
      frame.isCompactSummary === true ||
      asRecord(frame.origin)?.kind === 'task-notification')
  )
}

/** Resume repair text is not conversation; semantic siblings still take their normal paths. */
export function claudeMessageWithoutSyntheticText(
  frame: Record<string, unknown>
): Record<string, unknown> | null {
  const message = asRecord(frame.message)
  const usage = asRecord(message?.usage)
  const content = message?.content
  if (
    frame.type !== 'assistant' ||
    message?.role !== 'assistant' ||
    message.model !== '<synthetic>' ||
    message.stop_reason !== 'stop_sequence' ||
    message.stop_sequence !== '' ||
    frame.error !== undefined ||
    frame.isApiErrorMessage === true ||
    frame.apiErrorStatus !== undefined ||
    frame.is_api_error_message === true ||
    frame.api_error !== undefined ||
    !usage ||
    ![
      'input_tokens',
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
      'output_tokens'
    ].every((key) => usage[key] === 0) ||
    !Array.isArray(content)
  ) {
    return frame
  }
  const text = content
    .flatMap((part) => {
      const block = asRecord(part)
      return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
    })
    .join('\n')
    .trim()
  if (text !== 'No response requested.') {
    return frame
  }
  const remaining = content.filter((part) => asRecord(part)?.type !== 'text')
  return remaining.length ? { ...frame, message: { ...message, content: remaining } } : null
}
