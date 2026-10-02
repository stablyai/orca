import type { NativeChatBlock } from '../../shared/native-chat-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import { readRecord, readString, readTextContent } from './codex-item-field-readers'
import type { CodexThreadItem } from './codex-thread-item-identity'

/** `userMessage` carries structured content parts; `agentMessage` a flat text. */
export function codexMessageBlocks(item: CodexThreadItem): NativeChatBlock[] {
  const text =
    item.type === 'agentMessage'
      ? (readString(item, 'text') ?? readTextContent(item, 'content'))
      : readString(item, 'text')
  if (text !== null) {
    return [{ type: 'text', text: boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text }]
  }
  const content = item.content
  if (!Array.isArray(content)) {
    return []
  }
  const blocks: NativeChatBlock[] = []
  for (const part of content) {
    if (typeof part !== 'object' || part === null) {
      continue
    }
    const record = readRecord(part)
    const partText = readString(record, 'text')
    if (partText !== null) {
      blocks.push({
        type: 'text',
        text: boundInlineText(partText, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
      })
      continue
    }
    if (record.type === 'image' && typeof record.url === 'string') {
      blocks.push({ type: 'image-ref', url: record.url })
    } else if (record.type === 'localImage' && typeof record.path === 'string') {
      blocks.push({ type: 'image-ref', path: record.path })
    }
  }
  return blocks
}
