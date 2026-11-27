import type { NativeChatMessage } from '../../../shared/native-chat/native-chat-types'
import { extractString } from '../../../shared/text/trimmed-string'
import { parseJsonObject } from '../../ai-vault/parsing/session-json-object'
import { asRecord } from '../../ai-vault/parsing/session-record-fields'
import { timestampMs } from '../../ai-vault/parsing/session-record-time'
import { claudeContentBlocks } from './transcript-record-blocks'

/** One Kimi wire record as chat history: the person's messages and each text block of the
 *  model's replies. Injected reminders (user role, not user origin), reasoning and tool runs stay
 *  in Kimi's own conversation, which the chat resumes. */
export function decodeKimiWireLine(
  line: string
): { recordId: string; message: NativeChatMessage } | null {
  const record = parseJsonObject(line)
  if (!record) {
    return null
  }
  const parsedTime = timestampMs(record.time)
  const timestamp = Number.isFinite(parsedTime) ? parsedTime : null
  if (record.type === 'context.append_message') {
    const message = asRecord(record.message)
    const id = extractString(message?.id)
    if (!message || !id || message.role !== 'user' || asRecord(message.origin)?.kind !== 'user') {
      return null
    }
    // Kimi keeps pasted images as inline data; history shows where one was, as Hermes's import does.
    const content = Array.isArray(message.content)
      ? message.content.map((part) =>
          asRecord(part)?.type === 'image_url' ? { type: 'text', text: '[image]' } : part
        )
      : message.content
    const blocks = claudeContentBlocks(content)
    return blocks.length > 0
      ? { recordId: id, message: { id, role: 'user', blocks, timestamp, source: 'transcript' } }
      : null
  }
  if (record.type === 'context.append_loop_event') {
    const event = asRecord(record.event)
    const part = asRecord(event?.part)
    const id = extractString(event?.uuid)
    if (event?.type !== 'content.part' || part?.type !== 'text' || !id) {
      return null
    }
    const text = typeof part.text === 'string' ? part.text : ''
    return text.trim()
      ? {
          recordId: id,
          message: {
            id,
            role: 'assistant',
            blocks: [{ type: 'text', text }],
            timestamp,
            source: 'transcript'
          }
        }
      : null
  }
  return null
}
