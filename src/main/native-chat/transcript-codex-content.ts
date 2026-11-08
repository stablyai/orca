import type { NativeChatBlock } from '../../shared/native-chat/native-chat-types'
import { asRecord, extractString } from '../ai-vault/session-scanner-values'
import { toolResultOutputWork } from './transcript-record-blocks'
import type { TranscriptWork } from './transcript-work-scheduler'

export function* codexTurnItemBlocks(content: unknown): TranscriptWork<NativeChatBlock[]> {
  if (!Array.isArray(content)) {
    return []
  }
  const blocks: NativeChatBlock[] = []
  for (const value of content) {
    yield 1
    const item = asRecord(value)
    if (!item) {
      continue
    }
    if (
      item.type === 'text' ||
      item.type === 'Text' ||
      item.type === 'input_text' ||
      item.type === 'output_text'
    ) {
      const text = extractString(item.text)
      if (text) {
        blocks.push({ type: 'text', text })
      }
      continue
    }
    if (item.type === 'image' || item.type === 'Image' || item.type === 'input_image') {
      const url = extractString(item.image_url) ?? extractString(item.url)
      if (url) {
        blocks.push({ type: 'image-ref', url })
      }
      continue
    }
    if (item.type === 'local_image' || item.type === 'LocalImage') {
      const path = extractString(item.path)
      if (path) {
        blocks.push({ type: 'image-ref', path })
      }
    }
  }
  return blocks
}

export function* codexToolResult(
  output: unknown,
  callId: string | null
): TranscriptWork<NativeChatBlock> {
  const record = asRecord(output)
  const isError = record?.success === false || record?.is_error === true
  return {
    type: 'tool-result',
    output: yield* toolResultOutputWork(record?.content ?? record?.output ?? output),
    ...(callId ? { callId } : {}),
    ...(isError ? { isError: true } : {})
  }
}

export function* codexSummaryText(summary: unknown): TranscriptWork<string | null> {
  if (!Array.isArray(summary)) {
    return null
  }
  const parts: string[] = []
  for (const item of summary) {
    yield 1
    const text = extractString(asRecord(item)?.text) ?? extractString(item)
    if (text) {
      parts.push(text)
    }
  }
  return parts.length ? parts.join('\n') : null
}

// Explicit skill expansions are model context, not the user's recorded prompt.
function isSkillContext(block: NativeChatBlock): boolean {
  return block.type === 'text' && block.text.trimStart().slice(0, 7).toLowerCase() === '<skill>'
}

export function* withoutSkillContext(blocks: NativeChatBlock[]): TranscriptWork<NativeChatBlock[]> {
  const visible: NativeChatBlock[] = []
  for (const block of blocks) {
    yield 1
    if (!isSkillContext(block)) {
      visible.push(block)
    }
  }
  return visible
}
