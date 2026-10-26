import { readOpenCodeNativeChatTranscriptFull } from './transcript-opencode'
import { isENOENT } from '../ipc/filesystem/filesystem-path-containment'
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
      sourceEmpty?: boolean
    }
  // notFound is retryable: the agent may not have flushed its transcript yet.
  | { error: string; notFound?: true }

export type ReadTranscriptOptions = ResolveSessionFileOptions & {
  filePath?: string
}

/** Read the full transcript with no message cap; skip malformed/unknown records using the tailer’s decoders. */
export async function readNativeChatTranscript(
  agent: AgentType,
  sessionId: string,
  options: ReadTranscriptOptions = {}
): Promise<ReadTranscriptResult> {
  if (resolveNativeChatTranscriptAgent(agent) === 'opencode') {
    return readOpenCodeNativeChatTranscriptFull(
      sessionId,
      {},
      undefined,
      agent === 'zcode' ? 'zcode' : undefined
    )
  }
  let filePath: string | null
  try {
    filePath = options.filePath ?? (await resolveSessionFilePath(agent, sessionId, options))
  } catch (err) {
    // Gate refusal is unavailable, never evidence that the transcript is missing.
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
    // First flush/rotation can race successful resolution; ENOENT remains retryable.
    if (isENOENT(err)) {
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
