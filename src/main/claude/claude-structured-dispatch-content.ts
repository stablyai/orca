import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_COUNT = 20
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_REPLAY_CONTENT_KEY_BYTES = 256

type ImageBudget = {
  count: number
  localBytes: number
}

export async function readClaudeImage(path: string, openImpl: typeof open = open): Promise<Buffer> {
  const file = await openImpl(path, 'r')
  try {
    const invalidImage = (): Error =>
      new Error(`Claude image must be a non-empty file no larger than ${MAX_IMAGE_BYTES} bytes`)
    const info = await file.stat()
    if (!info.isFile()) {
      throw new Error('Claude image must be a file')
    }
    if (info.size > MAX_IMAGE_BYTES) {
      throw invalidImage()
    }
    const buffer = Buffer.allocUnsafe(info.size + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (result.bytesRead === 0) {
        break
      }
      bytesRead += result.bytesRead
    }
    // A file can grow after the initial stat and after the final read returns
    // zero. Prove the descriptor's size matches what was copied before sending.
    const finalInfo = await file.stat()
    if (bytesRead === 0 || bytesRead > MAX_IMAGE_BYTES || finalInfo.size !== bytesRead) {
      throw invalidImage()
    }
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
}

async function imageContent(
  block: Extract<NativeChatBlock, { type: 'image-ref' }>,
  budget: ImageBudget
): Promise<unknown> {
  budget.count += 1
  if (budget.count > MAX_IMAGE_COUNT) {
    throw new Error(`Claude messages support at most ${MAX_IMAGE_COUNT} images`)
  }
  if (block.url) {
    return { type: 'image', source: { type: 'url', url: block.url } }
  }
  if (!block.path) {
    throw new Error('image reference has neither a path nor a URL')
  }
  const data = await readClaudeImage(block.path)
  budget.localBytes += data.byteLength
  if (budget.localBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new Error(`Claude images must total no more than ${MAX_TOTAL_IMAGE_BYTES} bytes`)
  }
  const mediaType = IMAGE_MIME_BY_EXTENSION[extname(block.path).toLowerCase()]
  if (!mediaType) {
    throw new Error(`Claude does not support the image type ${extname(block.path)}`)
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data: data.toString('base64')
    }
  }
}

export async function claudeDispatchMessageContent(
  body: AgentJournalMessageItem
): Promise<unknown[]> {
  if (body.role !== 'user') {
    throw new Error('Claude dispatch accepts only user messages')
  }
  const content: unknown[] = []
  const imageBudget: ImageBudget = { count: 0, localBytes: 0 }
  for (const block of body.blocks as NativeChatBlock[]) {
    if (block.type === 'text' && block.text.length > 0) {
      content.push({ type: 'text', text: block.text })
    } else if (block.type === 'image-ref') {
      content.push(await imageContent(block, imageBudget))
    }
  }
  if (content.length === 0) {
    throw new Error('Claude dispatch requires text or an image')
  }
  return content
}

/**
 * Keep waiter metadata bounded even when a dispatch contains large base64 images.
 * The digest is only diagnostic: replay acknowledgement must use provider identity.
 */
export function claudeDispatchContentKey(content: readonly unknown[]): string {
  const digest = createHash('sha256')
  const summary = content
    .map((part) => {
      const record =
        typeof part === 'object' && part !== null && !Array.isArray(part)
          ? (part as Record<string, unknown>)
          : null
      const type = typeof record?.type === 'string' ? record.type : 'unknown'
      if (type === 'text') {
        return `text:${typeof record?.text === 'string' ? record.text.length : 0}`
      }
      const source =
        typeof record?.source === 'object' && record.source !== null
          ? (record.source as Record<string, unknown>)
          : null
      if (type === 'image' && source?.type === 'base64') {
        return `image:${typeof source.media_type === 'string' ? source.media_type : ''}:${typeof source.data === 'string' ? source.data.length : 0}`
      }
      return type
    })
    .join(',')
  for (const [index, part] of content.entries()) {
    const record =
      typeof part === 'object' && part !== null && !Array.isArray(part)
        ? (part as Record<string, unknown>)
        : null
    const type = typeof record?.type === 'string' ? record.type : 'unknown'
    digest.update(`${index}:${type}:`)
    if (type === 'text' && typeof record?.text === 'string') {
      digest.update(record.text)
      continue
    }
    const source =
      typeof record?.source === 'object' && record.source !== null
        ? (record.source as Record<string, unknown>)
        : null
    if (type === 'image' && source?.type === 'base64') {
      digest.update(typeof source.media_type === 'string' ? source.media_type : '')
      digest.update(':')
      if (typeof source.data === 'string') {
        digest.update(source.data)
      }
      continue
    }
    digest.update(JSON.stringify(part))
  }
  const key = `v1:${summary.slice(0, 128)}:${digest.digest('hex')}`
  return key.slice(0, MAX_REPLAY_CONTENT_KEY_BYTES)
}
