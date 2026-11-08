import {
  finishTranscriptWork,
  type TranscriptWork
} from '../../../native-chat/transcript-work-scheduler'
import type { NativeChatBlock } from '../../../../shared/native-chat/native-chat-types'
import {
  readRecord,
  readString,
  readTextContentWork
} from '../../app-server/codex-item-field-readers'
import type { CodexThreadItem } from './codex-thread-item-identity'

export function codexMessageBlocks(item: CodexThreadItem): NativeChatBlock[] {
  return finishTranscriptWork(codexMessageBlocksWork(item))
}

export function* codexMessageBlocksWork(item: CodexThreadItem): TranscriptWork<NativeChatBlock[]> {
  const text =
    item.type === 'agentMessage'
      ? (readString(item, 'text') ?? (yield* readTextContentWork(item, 'content')))
      : readString(item, 'text')
  if (text !== null) {
    return [{ type: 'text', text }]
  }
  const content = item.content
  if (!Array.isArray(content)) {
    return []
  }
  const blocks: NativeChatBlock[] = []
  for (const part of content) {
    yield 1
    if (typeof part !== 'object' || part === null) {
      continue
    }
    const record = readRecord(part)
    const partText = readString(record, 'text')
    if (partText !== null) {
      blocks.push({ type: 'text', text: partText })
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
