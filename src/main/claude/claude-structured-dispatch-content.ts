import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import {
  agentSessionFailureFact,
  type AgentSessionAttachmentProblem,
  type SubmissionRejectionFact
} from '../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentJournalDispatchRejection
} from '../../shared/agent-session-failure-words'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/tui-agent-display-names'
import { claudeRecord } from './claude-structured-item-translation'

export class ClaudeDispatchContentError extends Error {
  readonly failure: SubmissionRejectionFact

  constructor(message: string, failure: SubmissionRejectionFact) {
    super(message)
    this.name = 'ClaudeDispatchContentError'
    this.failure = failure
  }
}

function attachmentError(message: string, attachment: AgentSessionAttachmentProblem): Error {
  return new ClaudeDispatchContentError(
    message,
    agentSessionFailureFact('attachmentInvalid', { attachment })
  )
}

export function claudeDispatchRejection(
  failure: SubmissionRejectionFact
): AgentJournalDispatchRejection {
  return agentSessionFailureWords(failure, {
    surface: 'rejection',
    agentName: TUI_AGENT_DISPLAY_NAMES.claude,
    provider: 'claude'
  })
}

/** Content-build failures are local refusals or unreadable attachments, never provider failures. */
export function claudeDispatchContentRejection(error: unknown): AgentJournalDispatchRejection {
  if (error instanceof ClaudeDispatchContentError) {
    return claudeDispatchRejection(error.failure)
  }
  console.warn('[claude-dispatch] attachment could not be read:', error)
  return claudeDispatchRejection(agentSessionFailureFact('attachmentUnreadable'))
}

const BYTES_PER_MB = 1024 * 1024
const MAX_IMAGE_BYTES = 5 * BYTES_PER_MB
const MAX_IMAGE_COUNT = 20
const MAX_TOTAL_IMAGE_BYTES = 20 * BYTES_PER_MB
const MAX_REPLAY_CONTENT_KEY_BYTES = 256

type ImageBudget = {
  count: number
  localBytes: number
}

export async function readClaudeImage(path: string, openImpl: typeof open = open): Promise<Buffer> {
  const file = await openImpl(path, 'r')
  try {
    const tooLarge = (): Error =>
      attachmentError(`Claude image must be no larger than ${MAX_IMAGE_BYTES} bytes`, {
        reason: 'tooLarge',
        limit: MAX_IMAGE_BYTES
      })
    const info = await file.stat()
    if (!info.isFile()) {
      throw attachmentError('Claude image must be a file', { reason: 'notAFile' })
    }
    if (info.size > MAX_IMAGE_BYTES) {
      throw tooLarge()
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
    // A file can grow after EOF; verify the open descriptor still matches the bytes read.
    const finalInfo = await file.stat()
    if (bytesRead > MAX_IMAGE_BYTES) {
      throw tooLarge()
    }
    if (finalInfo.size !== bytesRead) {
      throw new Error('Claude image changed while it was read')
    }
    if (bytesRead === 0) {
      throw attachmentError('Claude image must be a non-empty file', { reason: 'empty' })
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
    throw attachmentError(`Claude messages support at most ${MAX_IMAGE_COUNT} images`, {
      reason: 'tooMany',
      limit: MAX_IMAGE_COUNT
    })
  }
  if (block.url) {
    return { type: 'image', source: { type: 'url', url: block.url } }
  }
  if (!block.path) {
    throw attachmentError('image reference has neither a path nor a URL', { reason: 'noSource' })
  }
  const data = await readClaudeImage(block.path)
  budget.localBytes += data.byteLength
  if (budget.localBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw attachmentError(`Claude images must total no more than ${MAX_TOTAL_IMAGE_BYTES} bytes`, {
      reason: 'totalTooLarge',
      limit: MAX_TOTAL_IMAGE_BYTES
    })
  }
  const mediaType = IMAGE_MIME_BY_EXTENSION[extname(block.path).toLowerCase()]
  if (!mediaType) {
    throw attachmentError(`Claude does not support the image type ${extname(block.path)}`, {
      reason: 'unsupportedType'
    })
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

/** Claude recovers only the trailing text as a prompt; ending in an image prevents slash expansion. */
export async function claudeDispatchMessageContent(
  body: AgentJournalMessageItem
): Promise<unknown[]> {
  if (body.role !== 'user') {
    throw new ClaudeDispatchContentError(
      'Claude dispatch accepts only user messages',
      agentSessionFailureFact('hostFault')
    )
  }
  const images: unknown[] = []
  const texts: string[] = []
  const imageBudget: ImageBudget = { count: 0, localBytes: 0 }
  for (const block of body.blocks as NativeChatBlock[]) {
    if (block.type === 'text' && block.text.length > 0) {
      texts.push(block.text)
    } else if (block.type === 'image-ref') {
      images.push(await imageContent(block, imageBudget))
    }
  }
  // Claude reads only the last text block, so join text to avoid losing earlier blocks.
  const content = texts.length > 0 ? [...images, { type: 'text', text: texts.join('\n') }] : images
  if (content.length === 0) {
    throw new ClaudeDispatchContentError(
      'Claude dispatch requires text or an image',
      agentSessionFailureFact('emptyMessage')
    )
  }
  return content
}

function claudeDispatchPrompt(content: readonly unknown[]): string | null {
  const last = claudeRecord(content.at(-1))
  return last?.type === 'text' && typeof last.text === 'string' ? last.text : null
}

/** Match Claude exactly: leading whitespace prevents slash-command expansion. */
export function claudeDispatchInvokesSlashCommand(content: readonly unknown[]): boolean {
  return claudeDispatchPrompt(content)?.startsWith('/') === true
}

/** Bound waiter metadata for large images; replay uses this digest only when identity cannot match. */
export function claudeDispatchContentKey(content: readonly unknown[]): string {
  const digest = createHash('sha256')
  const summary = content
    .map((part) => {
      const record = claudeRecord(part)
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
    const record = claudeRecord(part)
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
