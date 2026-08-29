import type {
  AgentType,
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../shared/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import { errorMessage } from '../ai-vault/session-scanner-values'
import { resolveSessionFilePath, type ResolveSessionFileOptions } from './session-file-resolver'
import { openTranscriptReadStream } from './wsl-transcript-fs-access'
import { wslTranscriptFsRefusal } from './wsl-transcript-fs-gate'
import {
  decodeClaudeTranscriptLine,
  decodeCodexTranscriptLine,
  decodeGrokTranscriptLine,
  decodeOmpTranscriptLine
} from './transcript-line-decoders'
import { decodeTranscriptStream } from './transcript-stream-lines'

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
  let filePath: string | null
  try {
    filePath = options.filePath ?? (await resolveSessionFilePath(agent, sessionId, options))
  } catch (err) {
    // Why: gate refusal is transient unavailability with retry guidance —
    // `notFound` would settle callers into a false "missing" state.
    return { error: wslTranscriptFsRefusal(err).message }
  }
  if (!filePath) {
    return { error: `No transcript found for ${agent} session ${sessionId}`, notFound: true }
  }
  try {
    const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
    if (transcriptAgent === 'claude') {
      return { messages: await readTranscript(filePath, decodeClaudeTranscriptLine) }
    }
    if (transcriptAgent === 'codex') {
      return { messages: await readTranscript(filePath, decodeCodexTranscriptLine) }
    }
    if (transcriptAgent === 'grok') {
      return { messages: await readTranscript(filePath, decodeGrokTranscriptLine) }
    }
    if (transcriptAgent === 'omp') {
      return { messages: await readTranscript(filePath, decodeOmpTranscriptLine) }
    }
    return { error: `Unsupported agent for Chat UI transcript: ${agent}` }
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
  const stream = openTranscriptReadStream(filePath, { encoding: 'utf-8' }, 'exact')
  const { messages } = await decodeTranscriptStream(stream, filePath, 0, decode, true)
  return messages
}
