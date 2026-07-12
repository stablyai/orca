import { createReadStream } from 'node:fs'
import type {
  AgentType,
  NativeChatMessage,
  NativeChatSessionMetadata
} from '../../shared/native-chat-types'
import { errorMessage } from '../ai-vault/session-scanner-values'
import { resolveSessionFilePath, type ResolveSessionFileOptions } from './session-file-resolver'
import {
  decodeClaudeTranscriptLine,
  decodeCodexTranscriptMetadataLine,
  decodeCodexTranscriptLine,
  decodeGrokTranscriptLine
} from './transcript-line-decoders'
import { decodeTranscriptStream } from './transcript-stream-lines'

export type ReadTranscriptResult =
  | { messages: NativeChatMessage[]; metadata?: NativeChatSessionMetadata }
  | { error: string }

export type ReadTranscriptOptions = ResolveSessionFileOptions & {
  /** Resolve directly to this file, skipping path discovery (used by tests). */
  filePath?: string
}

/**
 * Read the ENTIRE Claude/Codex JSONL transcript for an agent + session id into
 * the NativeChatMessage model. Unlike the AI-Vault preview scan, this applies
 * NO message cap. Unknown record types are skipped rather than throwing, so a
 * single malformed/unrecognized line cannot fail the whole read. The per-line
 * record-to-message mapping is shared with the live tailer.
 */
export async function readNativeChatTranscript(
  agent: AgentType,
  sessionId: string,
  options: ReadTranscriptOptions = {}
): Promise<ReadTranscriptResult> {
  const filePath = options.filePath ?? (await resolveSessionFilePath(agent, sessionId, options))
  if (!filePath) {
    return { error: `No transcript found for ${agent} session ${sessionId}` }
  }
  try {
    if (agent === 'claude') {
      return await readTranscript(filePath, decodeClaudeTranscriptLine)
    }
    if (agent === 'codex') {
      return await readTranscript(
        filePath,
        decodeCodexTranscriptLine,
        decodeCodexTranscriptMetadataLine
      )
    }
    if (agent === 'grok') {
      return await readTranscript(filePath, decodeGrokTranscriptLine)
    }
    return { error: `Unsupported agent for native chat transcript: ${agent}` }
  } catch (err) {
    return { error: errorMessage(err) }
  }
}

async function readTranscript(
  filePath: string,
  decode: (line: string, fallbackId: string) => NativeChatMessage | null,
  decodeMetadata?: (line: string) => NativeChatSessionMetadata | null
): Promise<{ messages: NativeChatMessage[]; metadata?: NativeChatSessionMetadata }> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const { messages, metadata } = await decodeTranscriptStream(
    stream,
    filePath,
    0,
    decode,
    true,
    decodeMetadata
  )
  return { messages, ...(metadata ? { metadata } : {}) }
}
