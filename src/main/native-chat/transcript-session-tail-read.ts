import { readOpenCodeNativeChatTranscriptTail } from './transcript-history/opencode/transcript-opencode'
import { isENOENT } from '../filesystem/local-file-io/filesystem-path-containment'
import type { AgentType } from '../../shared/agent-status/contracts/agent-status-types'
import type {
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../shared/native-chat/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat/native-chat-agent-support'
import { resolveSessionFilePath, type ResolveSessionFileOptions } from './session-file-resolver'
import { nativeChatTurnLifecycleDecoderForAgent } from './transcript-decoding/transcript-turn-lifecycle'
import { wslTranscriptFsRefusal } from './transcript-filesystem/wsl-transcript-fs-error'
import {
  nativeChatLineDecoderForAgent,
  readNativeChatTranscriptTailFile
} from './transcript-tail-reader'

export async function readNativeChatTranscriptTail(
  args: ResolveSessionFileOptions & {
    agent: AgentType
    sessionId: string
    transcriptPath?: string
    filePath?: string
    limit: number
    beforeOffset?: number
    sourceOrder?: boolean
  },
  signal?: AbortSignal
): Promise<
  | {
      messages: NativeChatMessage[]
      lifecycle?: NativeChatTurnLifecycle
      hasMore: boolean
      beforeOffset: number
    }
  | { error: string; notFound?: true }
> {
  if (resolveNativeChatTranscriptAgent(args.agent) === 'opencode') {
    return readOpenCodeNativeChatTranscriptTail(
      { ...args, agent: args.agent === 'zcode' ? 'zcode' : undefined },
      {},
      signal
    )
  }
  const decode = nativeChatLineDecoderForAgent(args.agent)
  const decodeLifecycle = nativeChatTurnLifecycleDecoderForAgent(args.agent)
  if (!decode) {
    return { error: 'Transcript unavailable' }
  }
  let filePath: string | null
  try {
    filePath =
      args.filePath ?? (await resolveSessionFilePath(args.agent, args.sessionId, args, signal))
  } catch (error) {
    signal?.throwIfAborted()
    // Gate refusal is unavailable, never proof of a missing transcript.
    return { error: wslTranscriptFsRefusal(error).message }
  }
  signal?.throwIfAborted()
  // Session IDs can arrive before the first flush; missing paths stay retryable.
  if (!filePath) {
    return { error: 'Transcript unavailable', notFound: true }
  }
  try {
    const result = await readNativeChatTranscriptTailFile(
      filePath,
      args.limit,
      decode,
      true,
      args.beforeOffset,
      decodeLifecycle,
      signal,
      undefined,
      args.sourceOrder
    )
    signal?.throwIfAborted()
    return {
      messages: result.messages,
      // Historical pages cannot rewind live lifecycle; only the current tail describes present turn state.
      ...(args.beforeOffset === undefined && result.lifecycle
        ? { lifecycle: result.lifecycle }
        : {}),
      hasMore: result.hasMore,
      beforeOffset: result.beforeOffset
    }
  } catch (error) {
    signal?.throwIfAborted()
    const message = error instanceof Error ? error.message : String(error)
    return isENOENT(error) ? { error: message, notFound: true } : { error: message }
  }
}
