import type {
  NativeChatBlock,
  NativeChatImageRefBlock,
  NativeChatToolResultBlock
} from '../../shared/native-chat/native-chat-types'
import { asRecord, extractString } from '../ai-vault/session-scanner-values'

/** Bytes live here, not on the block, so a snapshot cannot serialize them. */
const pendingToolResultImages = new WeakMap<NativeChatToolResultBlock, ToolResultImageSource[]>()

export type ToolResultImageSource = {
  path?: string
  url?: string
  alt?: string
  mediaType?: string
  base64?: string
}

export function takePendingToolResultImages(
  block: NativeChatBlock
): ToolResultImageSource[] | undefined {
  if (block.type !== 'tool-result') {
    return undefined
  }
  const pending = pendingToolResultImages.get(block)
  if (pending) {
    pendingToolResultImages.delete(block)
  }
  return pending
}

export function movePendingToolResultImages(from: NativeChatBlock, to: NativeChatBlock): void {
  const pending = takePendingToolResultImages(from)
  if (pending && to.type === 'tool-result') {
    pendingToolResultImages.set(to, pending)
  }
}

export function toolResultOutput(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (!Array.isArray(value)) {
    const record = asRecord(value)
    if (record) {
      const text = extractString(record.text) ?? extractString(record.content)
      if (text) {
        return text
      }
    }
    return value === undefined || value === null ? '' : JSON.stringify(value)
  }
  const parts: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(item)
      continue
    }
    const record = asRecord(item)
    const text = extractString(record?.text) ?? extractString(record?.content)
    if (text) {
      parts.push(text)
    }
  }
  return parts.join('\n')
}

export function claudeContentBlocks(content: unknown): NativeChatBlock[] {
  if (typeof content === 'string') {
    const text = content.trim()
    return text ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) {
    return []
  }
  const blocks: NativeChatBlock[] = []
  for (const item of content) {
    if (typeof item === 'string') {
      if (item.trim()) {
        blocks.push({ type: 'text', text: item })
      }
      continue
    }
    const record = asRecord(item)
    if (!record) {
      continue
    }
    blocks.push(...claudeContentBlock(record))
  }
  return blocks
}

function claudeContentBlock(record: Record<string, unknown>): NativeChatBlock[] {
  switch (record.type) {
    case 'text': {
      const text = extractString(record.text)
      return text ? [{ type: 'text', text }] : []
    }
    case 'thinking': {
      // Reasoning uses text blocks; message role carries its classification.
      const text = extractString(record.thinking) ?? extractString(record.text)
      return text ? [{ type: 'text', text }] : []
    }
    case 'tool_use': {
      const name = extractString(record.name) ?? 'tool'
      const callId = extractString(record.id)
      return [{ type: 'tool-call', name, input: record.input, ...(callId ? { callId } : {}) }]
    }
    case 'tool_result':
      return toolResultBlocks(record.content, {
        callId: extractString(record.tool_use_id) ?? undefined,
        isError: record.is_error === true
      })
    case 'image': {
      const image = imageRefBlock(record)
      return image ? [image] : []
    }
    default:
      return []
  }
}

export function toolResultBlocks(
  content: unknown,
  options: { callId?: string; isError?: boolean } = {}
): NativeChatBlock[] {
  const block: NativeChatToolResultBlock = {
    type: 'tool-result',
    output: toolResultOutput(content),
    ...(options.callId ? { callId: options.callId } : {}),
    ...(options.isError ? { isError: true } : {})
  }
  const images = collectToolResultImageSources(content)
  if (images.length > 0) {
    pendingToolResultImages.set(block, images)
  }
  return [block]
}

export function collectToolResultImageSources(value: unknown): ToolResultImageSource[] {
  const sources: ToolResultImageSource[] = []
  for (const record of imageRecords(value)) {
    const source = imageSource(record)
    if (source) {
      sources.push(source)
    }
  }
  return sources
}

function imageRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const record = asRecord(item)
      return record ? [record] : []
    })
  }
  const record = asRecord(value)
  if (!record) {
    return []
  }
  if (isImageRecord(record)) {
    return [record]
  }
  if (Array.isArray(record.content)) {
    return imageRecords(record.content)
  }
  if (Array.isArray(record.output)) {
    return imageRecords(record.output)
  }
  return []
}

function isImageRecord(record: Record<string, unknown>): boolean {
  return (
    record.type === 'image' ||
    record.type === 'Image' ||
    record.type === 'input_image' ||
    record.type === 'local_image' ||
    record.type === 'LocalImage'
  )
}

function imageSource(record: Record<string, unknown>): ToolResultImageSource | null {
  if (!isImageRecord(record)) {
    return null
  }
  const source = asRecord(record.source)
  const alt = extractString(record.alt) ?? undefined
  const url =
    extractString(source?.url) ?? extractString(record.url) ?? extractString(record.image_url)
  const path =
    extractString(record.path) ?? extractString(source?.path) ?? extractString(source?.file_path)
  const inline = extractString(source?.data) ?? (source ? null : extractString(record.data))
  const base64 = inline ?? dataUrlPayload(url)
  const mediaType =
    extractString(source?.media_type) ??
    extractString(record.mimeType) ??
    extractString(record.media_type) ??
    undefined
  if (!path && !url && !base64) {
    return null
  }
  return {
    ...(path ? { path } : {}),
    ...(url && !url.startsWith('data:') ? { url } : {}),
    ...(alt ? { alt } : {}),
    ...(mediaType ? { mediaType } : {}),
    ...(base64 ? { base64 } : {})
  }
}

function dataUrlPayload(url: string | null): string | null {
  if (!url?.startsWith('data:')) {
    return null
  }
  const comma = url.indexOf(',')
  return comma === -1 ? null : url.slice(comma + 1)
}

function imageRefBlock(record: Record<string, unknown>): NativeChatImageRefBlock | null {
  const source = asRecord(record.source)
  const url = extractString(source?.url) ?? extractString(record.url)
  const path = extractString(record.path)
  const alt = extractString(record.alt) ?? undefined
  if (!url && !path) {
    return null
  }
  return {
    type: 'image-ref',
    ...(path ? { path } : {}),
    ...(url ? { url } : {}),
    ...(alt ? { alt } : {})
  }
}
