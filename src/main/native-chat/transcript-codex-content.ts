import type { NativeChatBlock } from '../../shared/native-chat/native-chat-types'
import { asRecord } from '../ai-vault/parsing/session-record-fields'
import { extractString } from '../../shared/trimmed-string'

export function codexSummaryText(summary: unknown): string | null {
  if (!Array.isArray(summary)) {
    return null
  }
  const parts: string[] = []
  for (const item of summary) {
    const text = extractString(asRecord(item)?.text) ?? extractString(item)
    if (text) {
      parts.push(text)
    }
  }
  return parts.length ? parts.join('\n') : null
}

export function codexTurnItemBlocks(content: unknown): NativeChatBlock[] {
  if (!Array.isArray(content)) {
    return []
  }
  const blocks: NativeChatBlock[] = []
  for (const value of content) {
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
