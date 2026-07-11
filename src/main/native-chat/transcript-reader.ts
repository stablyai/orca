import { createReadStream } from 'node:fs'
import type {
  AgentType,
  NativeChatMessage,
  NativeChatSessionModel
} from '../../shared/native-chat-types'
import { errorMessage } from '../ai-vault/session-scanner-values'
import { resolveSessionFilePath, type ResolveSessionFileOptions } from './session-file-resolver'
import {
  decodeClaudeTranscriptLine,
  decodeCodexTranscriptLine,
  decodeGrokTranscriptLine
} from './transcript-line-decoders'
import { decodeTranscriptStream } from './transcript-stream-lines'
import { readCodexSessionModel } from './codex-session-model'

export type ReadTranscriptResult =
  | { messages: NativeChatMessage[]; sessionModel?: NativeChatSessionModel }
  | { error: string }

export type ReadTranscriptOptions = ResolveSessionFileOptions & {
  /** Resolve directly to this file, skipping path discovery (used by tests). */
  filePath?: string
  /** Read only the newest messages when callers use windowed pagination. */
  maxMessages?: number
}

/**
 * Read the ENTIRE Claude/Codex JSONL transcript for an agent + session id into
 * the NativeChatMessage model. Unlike the AI-Vault preview scan, this applies
 * no implicit message cap. Windowed callers can request only the newest
 * messages with maxMessages. Unknown record types are skipped rather than
 * throwing, and the per-line mapping is shared with the live tailer.
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
      return {
        messages: await readTranscript(filePath, decodeClaudeTranscriptLine, options.maxMessages)
      }
    }
    if (agent === 'codex') {
      const messages = await readTranscript(
        filePath,
        decodeCodexTranscriptLine,
        options.maxMessages
      )
      const sessionModel = await readCodexSessionModel(filePath)
      return {
        messages,
        ...(sessionModel ? { sessionModel } : {})
      }
    }
    if (agent === 'grok') {
      return {
        messages: await readTranscript(filePath, decodeGrokTranscriptLine, options.maxMessages)
      }
    }
    return { error: `Unsupported agent for native chat transcript: ${agent}` }
  } catch (err) {
    return { error: errorMessage(err) }
  }
}

async function readTranscript(
  filePath: string,
  decode: (line: string, fallbackId: string) => NativeChatMessage | null,
  maxMessages?: number
): Promise<NativeChatMessage[]> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const { messages } = await decodeTranscriptStream(stream, filePath, 0, decode, true)
  const requestedMax =
    maxMessages && Number.isFinite(maxMessages) && maxMessages > 0 ? Math.floor(maxMessages) : null
  return requestedMax === null ? messages : messages.slice(-requestedMax)
}
