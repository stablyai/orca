import { createHash } from 'node:crypto'
import { z } from 'zod'
import type {
  ConversationReferenceMessage,
  ConversationReferenceRead
} from '../../shared/conversation-reference'
import type { TranscriptMessage } from './session-transcript-consumers'
import { sliceAtCodeUnitLimit } from './session-scanner-text-normalization'

const PAGE_CHARACTERS = 24 * 1024
const Cursor = z
  .object({
    id: z.string(),
    version: z.string(),
    query: z.string(),
    message: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative()
  })
  .strict()

export function collectConversationReferencePage(
  id: string,
  version: string,
  request: ConversationReferenceRead
): {
  push: (message: TranscriptMessage) => void
  reset: () => void
  finish: () => {
    messages: ConversationReferenceMessage[]
    nextCursor: string | null
    warnings: string[]
  }
} {
  const query = request.query?.toLocaleLowerCase() ?? ''
  const queryId = createHash('sha256').update(query).digest('hex')
  let start = request.fromMessage ?? 0
  let startOffset = 0
  if (request.cursor) {
    let cursor: z.infer<typeof Cursor>
    try {
      cursor = Cursor.parse(JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')))
    } catch {
      throw new Error('Invalid conversation cursor. Read the conversation again without --cursor.')
    }
    if (cursor.id !== id || cursor.query !== queryId || cursor.version !== version) {
      throw new Error('The conversation or query changed. Read it again without --cursor.')
    }
    start = cursor.message
    startOffset = cursor.offset
  }
  const messages: ConversationReferenceMessage[] = []
  const warnings = new Set<string>()
  let index = 0
  let remaining = PAGE_CHARACTERS
  let next: { message: number; offset: number } | null = null
  const reset = (): void => {
    messages.length = 0
    warnings.clear()
    index = 0
    remaining = PAGE_CHARACTERS
    next = null
  }
  return {
    reset,
    push(message) {
      const current = index++
      if (message.textTruncated) {
        warnings.add('Some source content was shortened by its provider reader.')
      }
      if (current < start || next || (query && !message.text.toLocaleLowerCase().includes(query))) {
        return
      }
      if (remaining === 0 || messages.length >= (request.limit ?? 20)) {
        next = { message: current, offset: 0 }
        return
      }
      const offset = current === start ? startOffset : 0
      if (offset > message.text.length) {
        throw new Error('The conversation cursor is outside its source message.')
      }
      const text = sliceAtCodeUnitLimit(message.text.slice(offset), remaining)
      const continued = offset + text.length < message.text.length
      messages.push({
        role: message.role,
        text,
        timestamp: message.timestamp,
        messageIndex: current,
        textOffset: offset,
        continued
      })
      remaining -= text.length
      if (continued) {
        next = { message: current, offset: offset + text.length }
      }
    },
    finish: () => ({
      messages,
      nextCursor: next
        ? Buffer.from(
            JSON.stringify({
              id,
              version,
              query: queryId,
              ...next
            })
          ).toString('base64url')
        : null,
      warnings: [...warnings]
    })
  }
}
