import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import { buildImageDataUri } from '../../shared/image-data-uri'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS } from '../native-chat/agent-session-journal/journal-payload-bounds'
import { readString } from './codex-item-field-readers'
import type { CodexThreadItem } from './codex-thread-item-identity'

// Leave room for operation text and the journal envelope beside inline image bytes.
const MAX_IMAGE_REFERENCE_BYTES = DEFAULT_JOURNAL_PAYLOAD_LIMITS.inlineHeadBytes / 2

function imagePath(item: CodexThreadItem, key: string): string | null {
  const value = readString(item, key)
  return value?.trim() && Buffer.byteLength(value, 'utf8') <= MAX_IMAGE_REFERENCE_BYTES
    ? value
    : null
}

function generatedImageUrl(item: CodexThreadItem): string | null {
  const result = readString(item, 'result')
  if (!result || result.length > MAX_IMAGE_REFERENCE_BYTES) {
    return null
  }
  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.*)$/s.exec(result)
  const base64 = (match?.[2] ?? result).replace(/\s/g, '')
  if (!base64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    return null
  }
  const url = buildImageDataUri(match?.[1] ?? 'image/png', base64)
  return url && url.length <= MAX_IMAGE_REFERENCE_BYTES ? url : null
}

export function codexImageItemBody(item: CodexThreadItem): AgentJournalMessageItem {
  let image: Extract<NativeChatBlock, { type: 'image-ref' }> | null = null
  let text: string
  if (item.type === 'imageView') {
    const path = imagePath(item, 'path')
    text = path ? 'Viewed image' : 'Image view: preview unavailable'
    image = path ? { type: 'image-ref', path } : null
  } else {
    const status = readString(item, 'status')
    if (item.failure || status === 'failed') {
      text = 'Image generation failed'
    } else if (status !== 'completed') {
      text = status === 'inProgress' ? 'Generating image…' : 'Image generation: preview unavailable'
    } else {
      const path = imagePath(item, 'savedPath')
      const url = path ? null : generatedImageUrl(item)
      image = path
        ? { type: 'image-ref', path }
        : url
          ? { type: 'image-ref', url, alt: 'Generated image' }
          : null
      text = image ? 'Generated image' : 'Image generated: preview unavailable'
    }
  }
  return {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text }, ...(image ? [image] : [])]
  }
}
