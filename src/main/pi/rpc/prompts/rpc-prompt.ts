import { extname } from 'node:path'
import {
  resolveJsonlRpcPeerOptions,
  type JsonlRpcPeerOptions
} from '../../../jsonl-rpc/peer-limits'
import {
  AGENT_SESSION_ATTACHMENT_MAX_BYTES,
  AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT,
  AGENT_SESSION_MESSAGE_IMAGE_MAX_TOTAL_BYTES
} from '../../../../shared/agent-session/agent-session-attachments'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatImageRefBlock } from '../../../../shared/native-chat/native-chat-types'
import {
  agentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../../../shared/agent-session/failures/agent-session-failure'
import type { AgentSessionAttachmentProblem } from '../../../../shared/agent-session/failures/agent-session-failure-details'
import {
  ClaudeDispatchContentError,
  readClaudeImage
} from '../../../claude/structured/claude-structured-dispatch-content'

type ImageLimits = { image: number; total: number }
const SHRUNK_IMAGE_LIMITS: ImageLimits = {
  image: AGENT_SESSION_ATTACHMENT_MAX_BYTES,
  total: AGENT_SESSION_MESSAGE_IMAGE_MAX_TOTAL_BYTES
}
const PEER_DEFAULTS = resolveJsonlRpcPeerOptions()
const MAX_TEXT_WIRE_BYTES = PEER_DEFAULTS.maxLineBytes - 1
// Pi before 1.5.1 sends mid-turn images unshrunk: keep each under Anthropic's 5 MB of base64 and
// the message to what one ordinary line held before.
const UNSHRUNK_IMAGE_LIMITS: ImageLimits = {
  image: (5 * 1024 * 1024 * 3) / 4,
  total: (PEER_DEFAULTS.maxLineBytes * 3) / 4
}
// Pi echoes a prompt back in its events and history replies, so reads need the same room as writes.
const MAX_LINE_BYTES =
  PEER_DEFAULTS.maxLineBytes +
  Math.ceil(AGENT_SESSION_MESSAGE_IMAGE_MAX_TOTAL_BYTES / 3) * 4 +
  AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT * 64 +
  1024
export const PI_RPC_PEER_OPTIONS = {
  maxLineBytes: MAX_LINE_BYTES,
  maxQueuedWriteBytes: PEER_DEFAULTS.maxQueuedWriteBytes + MAX_LINE_BYTES
} satisfies JsonlRpcPeerOptions
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
  maxBytes: number
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
    bytes = await readClaudeImage(block.path, maxBytes)
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
  if (imageMime(bytes) !== mimeType) {
    throw attachmentError('Pi image file did not contain a supported image', {
      reason: 'unsupportedType'
    })
  }
  return { bytes, mimeType }
}

export async function preparePiRpcPrompt(
  body: AgentJournalMessageItem,
  piShrinksImages: boolean
): Promise<PiRpcPrompt> {
  const limits = piShrinksImages ? SHRUNK_IMAGE_LIMITS : UNSHRUNK_IMAGE_LIMITS
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
      if (images.length >= AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT) {
        throw attachmentError('Pi prompt has too many images', {
          reason: 'tooMany',
          limit: AGENT_SESSION_MESSAGE_IMAGE_MAX_COUNT
        })
      }
      const { bytes, mimeType } = await readImage(block, limits.image)
      totalImageBytes += bytes.byteLength
      if (totalImageBytes > limits.total) {
        throw attachmentError('Pi images exceed the total size limit', {
          reason: 'totalTooLarge',
          limit: limits.total
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
    images
  }
  // Images are bounded by their total above; the rest of the line keeps the ordinary limit.
  if (Buffer.byteLength(JSON.stringify({ ...prompt, images: [] }), 'utf8') > MAX_TEXT_WIRE_BYTES) {
    throw new PiRpcPromptError(
      'Pi prompt exceeds the RPC write limit',
      agentSessionFailureFact('historyTooLarge')
    )
  }
  return prompt
}
