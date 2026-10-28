import { extname } from 'node:path'
import { resolveJsonlRpcPeerOptions } from '../jsonl-rpc/peer-limits'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { NativeChatImageRefBlock } from '../../shared/native-chat-types'
import {
  agentSessionFailureFact,
  type AgentSessionAttachmentProblem,
  type SubmissionRejectionFact
} from '../../shared/agent-session-failure'
import {
  ClaudeDispatchContentError,
  readClaudeImage
} from '../claude/claude-structured-dispatch-content'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_COUNT = 20
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_PROMPT_WIRE_BYTES = resolveJsonlRpcPeerOptions().maxLineBytes - 1
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
}

export type PiRpcPrompt = Record<string, unknown> & {
  type: 'prompt'
  message: string
  images: { type: 'image'; data: string; mimeType: string }[]
  streamingBehavior?: 'steer' | 'followUp'
}

type ImageReads = {
  readLocal(path: string): Promise<Buffer>
}

export class PiRpcPromptError extends Error {
  constructor(
    message: string,
    readonly failure: SubmissionRejectionFact
  ) {
    super(message)
    this.name = 'PiRpcPromptError'
  }
}

function attachmentError(
  message: string,
  attachment: AgentSessionAttachmentProblem
): PiRpcPromptError {
  return new PiRpcPromptError(message, agentSessionFailureFact('attachmentInvalid', { attachment }))
}

function imageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 6 &&
    Buffer.from(bytes.subarray(0, 6))
      .toString('ascii')
      .match(/^GIF8[79]a$/)
  ) {
    return 'image/gif'
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

async function readImage(
  block: NativeChatImageRefBlock,
  reads: ImageReads
): Promise<{ bytes: Buffer; mimeType: string }> {
  if (block.url) {
    throw attachmentError('Pi does not accept image URLs', { reason: 'unsupportedType' })
  }
  if (!block.path) {
    throw attachmentError('Pi image needs a local path', { reason: 'noSource' })
  }
  const mimeType = MIME_BY_EXTENSION[extname(block.path).toLowerCase()]
  if (!mimeType) {
    throw attachmentError('Pi image file type is unsupported', { reason: 'unsupportedType' })
  }
  let bytes: Buffer
  try {
    bytes = await reads.readLocal(block.path)
  } catch (error) {
    if (error instanceof ClaudeDispatchContentError) {
      throw new PiRpcPromptError('Pi image could not be read', error.failure)
    }
    throw new PiRpcPromptError(
      'Pi image could not be read',
      agentSessionFailureFact('attachmentUnreadable')
    )
  }
  if (bytes.byteLength === 0) {
    throw attachmentError('Pi image is empty', { reason: 'empty' })
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw attachmentError('Pi image exceeds the size limit', {
      reason: 'tooLarge',
      limit: MAX_IMAGE_BYTES
    })
  }
  if (imageMime(bytes) !== mimeType) {
    throw attachmentError('Pi image file did not contain a supported image', {
      reason: 'unsupportedType'
    })
  }
  return { bytes, mimeType }
}

export async function preparePiRpcPrompt(
  body: AgentJournalMessageItem,
  streamingBehavior?: PiRpcPrompt['streamingBehavior'],
  reads: ImageReads = { readLocal: readClaudeImage }
): Promise<PiRpcPrompt> {
  if (body.role !== 'user') {
    throw new Error('Pi prompt must be a user message')
  }
  const texts: string[] = []
  const images: PiRpcPrompt['images'] = []
  let totalImageBytes = 0
  for (const block of body.blocks) {
    if (block.type === 'text' && block.text.length > 0) {
      texts.push(block.text)
    } else if (block.type === 'image-ref') {
      if (images.length >= MAX_IMAGE_COUNT) {
        throw attachmentError('Pi prompt has too many images', {
          reason: 'tooMany',
          limit: MAX_IMAGE_COUNT
        })
      }
      const { bytes, mimeType } = await readImage(block, reads)
      totalImageBytes += bytes.byteLength
      if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
        throw attachmentError('Pi images exceed the total size limit', {
          reason: 'totalTooLarge',
          limit: MAX_TOTAL_IMAGE_BYTES
        })
      }
      images.push({ type: 'image', data: bytes.toString('base64'), mimeType })
    }
  }
  if (texts.length === 0 && images.length === 0) {
    throw new PiRpcPromptError('Pi prompt is empty', agentSessionFailureFact('emptyMessage'))
  }
  const prompt: PiRpcPrompt = {
    type: 'prompt',
    message: texts.join('\n'),
    images,
    ...(streamingBehavior ? { streamingBehavior } : {})
  }
  if (Buffer.byteLength(JSON.stringify(prompt), 'utf8') > MAX_PROMPT_WIRE_BYTES) {
    throw new PiRpcPromptError(
      'Pi prompt exceeds the RPC write limit',
      agentSessionFailureFact('historyTooLarge')
    )
  }
  return prompt
}
