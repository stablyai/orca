import { extname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  agentSessionFailureFact,
  type AgentSessionAttachmentProblem,
  type SubmissionRejectionFact
} from '../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentJournalDispatchRejection
} from '../../shared/agent-session-failure-words'
import { formatNativeChatFileReference } from '../../shared/agent-image-paste'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { IMAGE_FILE_MIME_TYPES } from '../../shared/image-file-extensions'
import type { NativeChatImageRefBlock } from '../../shared/native-chat-types'
import {
  NodeFileReadTooLargeError,
  readNodeFileWithinLimit
} from '../../shared/node-bounded-file-reader'
import type { AcpLaunchSpec } from './acp-launch-specs'
import { resolveAcpPeerOptions } from './acp-peer-limits'
import { acpAgentName } from './acp-structured-agent-definitions'
import type { AcpStructuredConnection } from './acp-structured-connection'
import { acpSessionAcceptsImages } from './acp-structured-options'
import type { ContentBlock } from './generated/acp-protocol.generated'

const ACP_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
// Reserve space for the JSON-RPC envelope around the prompt blocks.
const ACP_PROMPT_LINE_BUDGET = resolveAcpPeerOptions().maxLineBytes - 64 * 1024
// Budget raw images for base64's 4:3 expansion and leave room for text.
export const ACP_PROMPT_IMAGE_MAX_BYTES = Math.floor((ACP_PROMPT_LINE_BUDGET * 3) / 4) - 1024 * 1024
const MAX_IMAGE_COUNT = 20
const READ_TIMEOUT_MS = 15_000

/** A local dispatch refusal, distinct from an agent rejection. */
export class AcpPromptContentError extends Error {
  constructor(readonly failure: SubmissionRejectionFact) {
    super(`ACP prompt refused: ${failure.kind}`)
    this.name = 'AcpPromptContentError'
  }
}

function attachmentProblem(attachment: AgentSessionAttachmentProblem): AcpPromptContentError {
  return new AcpPromptContentError(agentSessionFailureFact('attachmentInvalid', { attachment }))
}

function hostImagePath(block: NativeChatImageRefBlock): string | null {
  let path = block.path
  if (!path && block.url?.startsWith('file:')) {
    try {
      path = fileURLToPath(block.url)
    } catch {
      return null
    }
  }
  return path && isAbsolute(path) ? path : null
}

async function imageBlock(
  block: NativeChatImageRefBlock,
  remainingBytes: number,
  signal: AbortSignal
): Promise<{ block: ContentBlock; bytes: number }> {
  const tooLarge = (): AcpPromptContentError =>
    attachmentProblem({
      reason: remainingBytes < ACP_PROMPT_IMAGE_MAX_BYTES ? 'totalTooLarge' : 'tooLarge',
      limit: ACP_PROMPT_IMAGE_MAX_BYTES
    })
  if (block.url?.startsWith('data:')) {
    const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(block.url)
    if (!match || !ACP_IMAGE_MIME_TYPES.has(match[1]) || match[2].length % 4 !== 0) {
      throw attachmentProblem({ reason: 'unsupportedType' })
    }
    const bytes = Buffer.byteLength(match[2], 'base64')
    if (bytes === 0) {
      throw attachmentProblem({ reason: 'empty' })
    }
    if (bytes > remainingBytes) {
      throw tooLarge()
    }
    return { block: { type: 'image', mimeType: match[1], data: match[2] }, bytes }
  }
  const path = hostImagePath(block)
  if (!path) {
    throw attachmentProblem({ reason: 'noSource' })
  }
  const mimeType = IMAGE_FILE_MIME_TYPES[extname(path).toLowerCase()]
  const fallback = {
    block: { type: 'text' as const, text: formatNativeChatFileReference(path) },
    bytes: 0
  }
  if (!mimeType || !ACP_IMAGE_MIME_TYPES.has(mimeType) || remainingBytes <= 0) {
    return fallback
  }
  let data: Buffer
  try {
    data = (await readNodeFileWithinLimit(path, remainingBytes, { regularFileOnly: true, signal }))
      .buffer
  } catch (error) {
    if (
      error instanceof NodeFileReadTooLargeError ||
      (signal.aborted && error === signal.reason) ||
      (error instanceof Error &&
        (error.message === 'Expected a regular file' ||
          ('errno' in error &&
            typeof error.errno === 'number' &&
            'syscall' in error &&
            typeof error.syscall === 'string')))
    ) {
      return fallback
    }
    throw error
  }
  if (data.byteLength === 0) {
    return fallback
  }
  return { block: { type: 'image', mimeType, data: data.toString('base64') }, bytes: data.length }
}

export async function acpPromptBlocks(
  body: AgentJournalMessageItem,
  acceptsImages: boolean
): Promise<ContentBlock[]> {
  // Reserve later text and file references before allocating image capacity.
  const blocks: ContentBlock[] = body.blocks.map((block) => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text }
    }
    const path = block.type === 'image-ref' ? hostImagePath(block) : null
    return { type: 'text', text: path ? formatNativeChatFileReference(path) : '' }
  })
  const blockBytes = (block: ContentBlock): number => Buffer.byteLength(JSON.stringify(block))
  let encodedBytes =
    2 + Math.max(0, blocks.length - 1) + blocks.reduce((n, b) => n + blockBytes(b), 0)
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS)
  let imageCount = 0
  let imageBytes = 0
  for (const [index, block] of body.blocks.entries()) {
    if (block.type === 'text') {
      continue
    }
    if (block.type !== 'image-ref') {
      throw attachmentProblem({ reason: 'unsupportedType' })
    }
    if (!acceptsImages) {
      const path = hostImagePath(block)
      if (!path) {
        throw attachmentProblem({ reason: 'unsupportedType' })
      }
      continue
    }
    const inline = block.url?.startsWith('data:')
    if (inline && imageCount >= MAX_IMAGE_COUNT) {
      throw attachmentProblem({ reason: 'tooMany', limit: MAX_IMAGE_COUNT })
    }
    const previousBytes = blockBytes(blocks[index]!)
    const path = hostImagePath(block)
    const mimeType = IMAGE_FILE_MIME_TYPES[extname(path ?? '').toLowerCase()] ?? ''
    const overhead = blockBytes({ type: 'image', mimeType, data: '' })
    const encodedCapacity =
      encodedBytes > ACP_PROMPT_LINE_BUDGET
        ? 0
        : 3 * Math.floor((ACP_PROMPT_LINE_BUDGET - encodedBytes + previousBytes - overhead) / 4)
    const remainingBytes = inline
      ? ACP_PROMPT_IMAGE_MAX_BYTES - imageBytes
      : imageCount >= MAX_IMAGE_COUNT
        ? 0
        : Math.min(ACP_PROMPT_IMAGE_MAX_BYTES - imageBytes, encodedCapacity)
    const image = await imageBlock(block, remainingBytes, signal)
    if (image.block.type === 'image') {
      imageCount += 1
    }
    imageBytes += image.bytes
    blocks[index] = image.block
    encodedBytes += blockBytes(image.block) - previousBytes
  }
  if (imageCount > 0 && Buffer.byteLength(JSON.stringify(blocks)) > ACP_PROMPT_LINE_BUDGET) {
    throw attachmentProblem({ reason: 'totalTooLarge', limit: ACP_PROMPT_IMAGE_MAX_BYTES })
  }
  return blocks
}

function isWithheldCommand(body: AgentJournalMessageItem, withheld: readonly string[]): boolean {
  const [block, ...rest] = body.blocks
  const text = block?.type === 'text' && rest.length === 0 ? block.text.trim() : ''
  return text.startsWith('/') && withheld.includes(text.slice(1))
}

export async function acpDispatchPrompt(
  body: AgentJournalMessageItem,
  session: {
    spec: Pick<AcpLaunchSpec, 'agent' | 'dialect'>
    connection: Pick<AcpStructuredConnection, 'initialize'>
  }
): Promise<ContentBlock[] | AgentJournalDispatchRejection> {
  if (isWithheldCommand(body, session.spec.dialect.withheldCommands ?? [])) {
    return agentSessionFailureWords(agentSessionFailureFact('commandUnavailable'), {
      surface: 'rejection',
      agentName: acpAgentName(session.spec.agent)
    })
  }
  try {
    return await acpPromptBlocks(body, await acpSessionAcceptsImages(session))
  } catch (error) {
    if (error instanceof AcpPromptContentError) {
      return agentSessionFailureWords(error.failure, {
        surface: 'rejection',
        agentName: acpAgentName(session.spec.agent)
      })
    }
    throw error
  }
}
