import crypto from 'node:crypto'
import type { NativeChatInputContent } from '../../shared/native-chat/transcript/native-chat-input-content'
import { asRecord } from '../ai-vault/parsing/session-record-fields'

/** Only source readers originate this evidence, before display filtering or trimming. */
export function transcriptInputContent(
  provider: NativeChatInputContent['provider'],
  content: unknown
): NativeChatInputContent | undefined {
  const text: string[] = []
  const images: string[] = []
  if (typeof content === 'string') {
    return completeInputContent(provider, content, images)
  }
  if (!Array.isArray(content)) {
    return undefined
  }
  for (const value of content) {
    if (typeof value === 'string') {
      text.push(value)
      continue
    }
    const part = asRecord(value)
    const type = part?.type
    if (
      (type === 'text' || type === 'Text' || type === 'input_text') &&
      typeof part?.text === 'string'
    ) {
      text.push(part.text)
    } else if (
      type === 'local_image' ||
      type === 'LocalImage' ||
      type === 'image' ||
      type === 'Image' ||
      type === 'input_image'
    ) {
      if (typeof part?.path !== 'string') {
        return undefined
      }
      images.push(part.path)
    } else {
      return undefined
    }
  }
  return completeInputContent(provider, text.join(''), images)
}

function completeInputContent(
  provider: NativeChatInputContent['provider'],
  text: string,
  images: string[]
): NativeChatInputContent {
  let textDigest: string | undefined
  return {
    provider,
    get textDigest() {
      if (textDigest === undefined) {
        textDigest = crypto.createHash('sha256').update(text).digest('hex')
        text = ''
      }
      return textDigest
    },
    images
  }
}

export function codexEventInputContent(
  payload: Record<string, unknown>
): NativeChatInputContent | undefined {
  // Other source kinds have no original local identity or universal ordering with local images.
  for (const field of [
    'images',
    'file_ids',
    'audio',
    'audio_references',
    'local_audio',
    'image_order',
    'audio_order'
  ]) {
    const value = payload[field]
    if (value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0)) {
      return undefined
    }
  }
  const content: unknown[] = Array.isArray(payload.message)
    ? [...payload.message]
    : [payload.message]
  if (payload.local_images !== undefined) {
    if (!Array.isArray(payload.local_images)) {
      return undefined
    }
    for (const path of payload.local_images) {
      content.push({ type: 'local_image', path })
    }
  }
  return transcriptInputContent('codex', content)
}

/** Peel only the producer's complete outer envelope, preserving nested tags and whitespace. */
export function grokInputContent(content: unknown): NativeChatInputContent | undefined {
  const peel = (text: string): string => {
    const opener = '<user_query>\n'
    const closer = '\n</user_query>'
    return text.startsWith(opener) && text.endsWith(closer)
      ? text.slice(opener.length, -closer.length)
      : text
  }
  const source =
    typeof content === 'string'
      ? peel(content)
      : Array.isArray(content)
        ? content.map((value) => {
            const part = asRecord(value)
            return typeof part?.text === 'string' ? { ...part, text: peel(part.text) } : value
          })
        : content
  return transcriptInputContent('grok', source)
}
