import { createReadStream } from 'node:fs'
import type { AgentType, NativeChatMessage } from '../../shared/native-chat-types'
import { errorMessage } from '../ai-vault/session-scanner-values'
import { resolveSessionFilePath, type ResolveSessionFileOptions } from './session-file-resolver'
import {
  decodeClaudeTranscriptLine,
  decodeCodexTranscriptLine,
  decodeGrokTranscriptLine
} from './transcript-line-decoders'
import { decodeTranscriptStream } from './transcript-stream-lines'

export type ReadTranscriptResult =
  | { messages: NativeChatMessage[] }
  // notFound marks a retry-worthy miss (transcript not flushed to disk yet,
  // #8401) as opposed to a real parse/IO error callers surface immediately.
  | { error: string; notFound?: true }

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
    return { error: `No transcript found for ${agent} session ${sessionId}`, notFound: true }
  }
  try {
    if (agent === 'claude') {
      return { messages: await readTranscript(filePath, decodeClaudeTranscriptLine) }
    }
    if (agent === 'codex') {
      return { messages: await readTranscript(filePath, decodeCodexTranscriptLine) }
    }
    if (agent === 'grok') {
      return { messages: await readTranscript(filePath, decodeGrokTranscriptLine) }
    }
    return { error: `Unsupported agent for native chat transcript: ${agent}` }
  } catch (err) {
    // Why: ENOENT after a successful resolve is the same first-flush/rotation
    // race as an unresolved path — keep it retry-worthy (#8401).
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return { error: errorMessage(err), notFound: true }
    }
    return { error: errorMessage(err) }
  }
}

async function readTranscript(
  filePath: string,
  decode: (line: string, fallbackId: string) => NativeChatMessage | null
): Promise<NativeChatMessage[]> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const { messages } = await decodeTranscriptStream(stream, filePath, 0, decode, true)
  return messages
}
