import type {
  AgentType,
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../shared/native-chat-types'
import { errorMessage } from '../ai-vault/session-scanner-values'
import { resolveSessionFilePath, type ResolveSessionFileOptions } from './session-file-resolver'
import { openTranscriptReadStream } from './wsl-transcript-fs-access'
import { wslTranscriptFsRefusal } from './wsl-transcript-fs-gate'
import { nativeChatLineDecoderForAgent } from './transcript-tail-reader'
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
 * Read a supported agent's JSONL transcript into the NativeChatMessage model.
 * Unlike the AI-Vault preview scan, this applies no message cap. Unknown records
 * are skipped rather than thrown so one malformed line cannot fail the read.
 * The per-line mapping is shared with the live tailer.
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
    const decode = nativeChatLineDecoderForAgent(agent)
    if (!decode) {
      return { error: `Unsupported agent for Chat UI transcript: ${agent}` }
    }
    return { messages: await readTranscript(filePath, decode) }
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
