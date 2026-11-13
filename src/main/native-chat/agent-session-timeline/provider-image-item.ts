import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatBlock } from '../../../shared/native-chat/native-chat-types'
import { buildImageDataUri } from '../../../shared/file-preview/image-data-uri'
import { NATIVE_CHAT_GENERATED_IMAGE_PRESENTATION } from '../../../shared/native-chat/native-chat-generated-image'
function readString(item: Readonly<Record<string, unknown>>, key: string): string | null {
  return typeof item[key] === 'string' ? item[key] : null
}

// Leave room for operation text and the journal envelope beside inline image bytes.
const MAX_IMAGE_REFERENCE_BYTES = 8 * 1024

export function imagePath(item: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = readString(item, key)
  return value?.trim() && Buffer.byteLength(value, 'utf8') <= MAX_IMAGE_REFERENCE_BYTES
    ? value
    : null
}

export function generatedImageUrl(item: Readonly<Record<string, unknown>>): string | null {
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

export function nativeChatImageItemBody(
  item: Readonly<Record<string, unknown>>
): AgentJournalMessageItem {
  let image: Extract<NativeChatBlock, { type: 'image-ref' }> | null = null
  let text: string
  let presentation: string | undefined
  if (item.type === 'imageView') {
    const path = imagePath(item, 'path')
    text = path ? 'Viewed image' : 'Image view: preview unavailable'
    image = path ? { type: 'image-ref', path } : null
  } else {
    const status = readString(item, 'status')
    if (item.failure || status === 'failed') {
      text = 'Image generation failed'
    } else if (status !== 'completed') {
      // Codex passes the Responses API status through, not the app-server's camelCase enum.
      text =
        status === 'in_progress' || status === 'inProgress' || status === 'generating'
          ? 'Generating image…'
          : 'Image generation: preview unavailable'
    } else {
      const path = imagePath(item, 'savedPath')
      const url = path ? null : generatedImageUrl(item)
      image = path
        ? { type: 'image-ref', path }
        : url
          ? { type: 'image-ref', url, alt: 'Generated image' }
          : null
      text = image ? 'Generated image' : 'Image generated: preview unavailable'
      presentation = image ? NATIVE_CHAT_GENERATED_IMAGE_PRESENTATION : undefined
    }
  }
  return {
    kind: 'message',
    role: 'assistant',
    blocks: [
      { type: 'text', text, ...(presentation ? { presentation } : {}) },
      ...(image ? [image] : [])
    ]
  }
}
