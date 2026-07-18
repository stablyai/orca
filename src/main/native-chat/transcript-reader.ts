import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type {
  AgentType,
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../shared/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import { isCodexCompressedRolloutPath } from '../ai-vault/session-scanner-codex-paths'
import { openCodexRolloutStream } from '../ai-vault/session-scanner-codex-rollout-read'
import { errorMessage } from '../ai-vault/session-scanner-values'
import { resolveSessionFilePath, type ResolveSessionFileOptions } from './session-file-resolver'
import {
  decodeClaudeTranscriptLine,
  createCodexTranscriptLineDecoder,
  decodeGrokTranscriptLine
} from './transcript-line-decoders'
import { decodeTranscriptStream } from './transcript-stream-lines'
import type { TranscriptDecodeLimits } from './transcript-stream-lines'
import { newlineAlignedTailStart, readStreamTail } from './transcript-tail-window'

export type ReadTranscriptResult =
  | {
      messages: NativeChatMessage[]
      lifecycle?: NativeChatTurnLifecycle
    }
  // notFound marks a retry-worthy miss (transcript not flushed to disk yet,
  // #8401) as opposed to a real parse/IO error callers surface immediately.
  | { error: string; notFound?: true }

export type ReadTranscriptOptions = ResolveSessionFileOptions & {
  /** Resolve directly to this file, skipping path discovery (used by tests). */
  filePath?: string
  /** Optional streaming limits for remote/windowed readers. Omitted for the
   *  desktop full-history contract. */
  limits?: TranscriptDecodeLimits
}

/**
 * Read a Claude/Codex JSONL transcript for an agent + session id into the
 * NativeChatMessage model. Desktop callers omit limits and retain full history;
 * remote callers provide streaming limits. Unknown record types are skipped
 * rather than failing the whole read. The per-line mapping is shared with the
 * live tailer.
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
    const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
    if (transcriptAgent === 'claude') {
      return {
        messages: await readTranscript(filePath, decodeClaudeTranscriptLine, options.limits)
      }
    }
    if (transcriptAgent === 'codex') {
      return {
        messages: await readTranscript(filePath, createCodexTranscriptLineDecoder(), options.limits)
      }
    }
    if (transcriptAgent === 'grok') {
      return { messages: await readTranscript(filePath, decodeGrokTranscriptLine, options.limits) }
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
  decode: (line: string, fallbackId: string) => NativeChatMessage | null,
  limits?: TranscriptDecodeLimits
): Promise<NativeChatMessage[]> {
  // Why: Codex cold-compresses older rollouts; other agents remain plain JSONL.
  // Keep plain reads as bytes so malformed UTF-8 cannot distort safety limits.
  const compressed = isCodexCompressedRolloutPath(filePath)
  let start = 0
  let stream: Readable
  if (compressed && limits?.maxDecodedBytes !== undefined) {
    const tail = await readStreamTail(openCodexRolloutStream(filePath), limits.maxDecodedBytes)
    start = tail.decodedStart
    stream = Readable.from(tail.bytes)
  } else if (compressed) {
    stream = openCodexRolloutStream(filePath)
  } else {
    const end = (await stat(filePath)).size
    start =
      limits?.maxDecodedBytes === undefined
        ? 0
        : await newlineAlignedTailStart(filePath, end, limits.maxDecodedBytes)
    stream = createReadStream(filePath, { start })
  }
  const { messages } = await decodeTranscriptStream(stream, filePath, start, decode, true, limits)
  return messages
}
