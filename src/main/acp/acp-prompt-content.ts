// A person's message as an ACP prompt. Images go as the protocol's image blocks, and only to an
// agent that advertised them; each is checked and read before anything reaches the agent.

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
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { IMAGE_FILE_MIME_TYPES } from '../../shared/image-file-extensions'
import type { NativeChatImageRefBlock } from '../../shared/native-chat-types'
import {
  NodeFileReadTooLargeError,
  readNodeFileWithinLimit
} from '../../shared/node-bounded-file-reader'
import type { AcpLaunchSpec } from './acp-launch-specs'
import { resolveAcpPeerOptions } from './acp-peer-limits'
import { acpAgentName } from './acp-structured-acquire'
import type { AcpStructuredConnection } from './acp-structured-connection'
import type { ContentBlock } from './generated/acp-protocol.generated'

const ACP_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
/** A prompt is one JSON-RPC line; this leaves room for the request around its blocks. */
const ACP_PROMPT_LINE_BUDGET = resolveAcpPeerOptions().maxLineBytes - 64 * 1024
/** One message's images together, raw: base64 makes each 4 bytes of them 3 more. */
export const ACP_PROMPT_IMAGE_MAX_BYTES = Math.floor((ACP_PROMPT_LINE_BUDGET * 3) / 4) - 1024 * 1024
const MAX_IMAGE_COUNT = 20
const READ_TIMEOUT_MS = 15_000

/** Why Orca did not send a message; never the agent's refusal. */
export class AcpPromptContentError extends Error {
  constructor(readonly failure: SubmissionRejectionFact) {
    super(`ACP prompt refused: ${failure.kind}`)
    this.name = 'AcpPromptContentError'
  }
}

function attachmentProblem(attachment: AgentSessionAttachmentProblem): AcpPromptContentError {
  return new AcpPromptContentError(agentSessionFailureFact('attachmentInvalid', { attachment }))
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
  let path = block.path
  if (!path && block.url?.startsWith('file:')) {
    try {
      path = fileURLToPath(block.url)
    } catch {
      throw attachmentProblem({ reason: 'noSource' })
    }
  }
  if (!path || !isAbsolute(path)) {
    throw attachmentProblem({ reason: 'noSource' })
  }
  const mimeType = IMAGE_FILE_MIME_TYPES[extname(path).toLowerCase()]
  if (!mimeType || !ACP_IMAGE_MIME_TYPES.has(mimeType)) {
    throw attachmentProblem({ reason: 'unsupportedType' })
  }
  let data: Buffer
  try {
    data = (await readNodeFileWithinLimit(path, remainingBytes, { regularFileOnly: true, signal }))
      .buffer
  } catch (error) {
    if (error instanceof NodeFileReadTooLargeError) {
      throw tooLarge()
    }
    if (error instanceof Error && error.message === 'Expected a regular file') {
      throw attachmentProblem({ reason: 'notAFile' })
    }
    throw new AcpPromptContentError(agentSessionFailureFact('attachmentUnreadable'))
  }
  if (data.byteLength === 0) {
    throw attachmentProblem({ reason: 'empty' })
  }
  return { block: { type: 'image', mimeType, data: data.toString('base64') }, bytes: data.length }
}

/** The prompt for `body`; throws `AcpPromptContentError` for what Orca will not send. */
export async function acpPromptBlocks(
  body: AgentJournalMessageItem,
  acceptsImages: boolean
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = []
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS)
  let imageCount = 0
  let imageBytes = 0
  for (const block of body.blocks) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type !== 'image-ref' || !acceptsImages) {
      throw attachmentProblem({ reason: 'unsupportedType' })
    }
    imageCount += 1
    if (imageCount > MAX_IMAGE_COUNT) {
      throw attachmentProblem({ reason: 'tooMany', limit: MAX_IMAGE_COUNT })
    }
    const image = await imageBlock(block, ACP_PROMPT_IMAGE_MAX_BYTES - imageBytes, signal)
    imageBytes += image.bytes
    blocks.push(image.block)
  }
  // Only images can carry a message past one line here; their words are the refusal's.
  if (imageCount > 0 && Buffer.byteLength(JSON.stringify(blocks)) > ACP_PROMPT_LINE_BUDGET) {
    throw attachmentProblem({ reason: 'totalTooLarge', limit: ACP_PROMPT_IMAGE_MAX_BYTES })
  }
  return blocks
}

/** The prompt for `body` to `session`'s agent, or Orca's refusal of it in words that name the
 *  agent. Images go only where the agent's row offers them and its start advertised them. */
export async function acpDispatchPrompt(
  body: AgentJournalMessageItem,
  session: {
    spec: Pick<AcpLaunchSpec, 'agent' | 'imagePrompts'>
    connection: Pick<AcpStructuredConnection, 'initialize'>
  }
): Promise<ContentBlock[] | AgentJournalDispatchRejection> {
  try {
    const advertised =
      session.spec.imagePrompts === true &&
      (await session.connection.initialize()).agentCapabilities?.promptCapabilities?.image === true
    return await acpPromptBlocks(body, advertised)
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
