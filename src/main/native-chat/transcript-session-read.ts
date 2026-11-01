import { readOpenCodeNativeChatTranscriptTail } from './transcript-opencode'
import { isENOENT } from '../ipc/filesystem/filesystem-path-containment'
import type { AgentType } from '../../shared/agent-status-types'
import type {
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../shared/native-chat/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat/native-chat-agent-support'
import { resolveSessionFilePath, type ResolveSessionFileOptions } from './session-file-resolver'
import { nativeChatTurnLifecycleDecoderForAgent } from './transcript-turn-lifecycle'
import {
  nativeChatLineDecoderForAgent,
  readNativeChatTranscriptTailFile,
  type NativeChatLineDecoder
} from './transcript-tail-reader'
import {
  readNativeChatSubagentPage,
  type NativeChatChildPage
} from './transcript-subagent-children'
import { wslTranscriptFsRefusal } from './wsl-transcript-fs-gate'

function readChildFile(
  decode: NativeChatLineDecoder,
  childPath: string,
  childLimit: number,
  endOffset: number | undefined,
  childSignal: AbortSignal | undefined
): Promise<NativeChatChildPage> {
  return readNativeChatTranscriptTailFile(
    childPath,
    childLimit,
    decode,
    true,
    endOffset,
    null,
    childSignal,
    undefined,
    true
  )
}

export async function readNativeChatTranscriptTail(
  args: ResolveSessionFileOptions & {
    agent: AgentType
    sessionId: string
    transcriptPath?: string
    filePath?: string
    limit: number
    beforeOffset?: number
    sourceOrder?: boolean
    /** One child's file. Absent reads the parent and does not embed other children. */
    subagentId?: string
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
    if (args.subagentId) {
      return { error: 'Transcript unavailable', notFound: true }
    }
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
    if (args.subagentId) {
      const page = await readNativeChatSubagentPage({
        parentPath: filePath,
        decode,
        agentId: args.subagentId,
        limit: args.limit,
        beforeOffset: args.beforeOffset,
        signal,
        readTail: (childPath, childLimit, endOffset, childSignal) =>
          readChildFile(decode, childPath, childLimit, endOffset, childSignal)
      })
      return page ?? { error: 'Transcript unavailable', notFound: true }
    }
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
