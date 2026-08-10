import { stat } from 'node:fs/promises'
import type { AgentType, NativeChatTurnLifecycle } from '../shared/native-chat-types'
import {
  SSH_NATIVE_CHAT_READ_LIMIT_MAX,
  SSH_NATIVE_CHAT_READ_TRANSCRIPT_METHOD,
  SSH_NATIVE_CHAT_TRANSCRIPT_PATH_MAX_LENGTH,
  type SshNativeChatRelayReadParams,
  type SshNativeChatRelayReadResult
} from '../shared/ssh-native-chat-relay'
import {
  resolveSessionFilePath,
  type ResolveSessionFileOptions
} from '../main/native-chat/session-file-resolver'
import { readIncrementalTranscriptMessages } from '../main/native-chat/transcript-incremental-reader'
import {
  nativeChatLineDecoderForAgent,
  readNativeChatTranscriptTail
} from '../main/native-chat/transcript-tail-reader'
import { nativeChatTurnLifecycleDecoderForAgent } from '../main/native-chat/transcript-turn-lifecycle'
import type { RelayDispatcher } from './dispatcher'

// Why: an SSH worktree's agent writes its transcript on THIS machine, so the
// desktop's own `~/.claude/projects` can never hold it. Resolving, reading and
// decoding here is the same split the AI Vault relay handler already uses: only
// decoded messages cross the mux, never the JSONL.
export class NativeChatHandler {
  constructor(dispatcher: RelayDispatcher) {
    dispatcher.onRequest(SSH_NATIVE_CHAT_READ_TRANSCRIPT_METHOD, (params, context) =>
      readRelayNativeChatTranscript(normalizeSshNativeChatRelayReadParams(params), {
        signal: context.signal
      })
    )
  }
}

export async function readRelayNativeChatTranscript(
  params: SshNativeChatRelayReadParams,
  /** `resolveOptions` isolates a test from this machine's real agent homes; the
   *  relay itself always resolves against its own runtime home. */
  options: { signal?: AbortSignal; resolveOptions?: ResolveSessionFileOptions } = {}
): Promise<SshNativeChatRelayReadResult> {
  const { signal } = options
  const agent = params.agent as AgentType
  const filePath = await resolveSessionFilePath(
    agent,
    params.sessionId,
    { ...options.resolveOptions, transcriptPath: params.transcriptPath },
    signal
  )
  if (!filePath) {
    return { error: 'Transcript unavailable', notFound: true }
  }
  const fileSize = await transcriptSize(filePath)
  if (fileSize === null) {
    return { error: 'Transcript unavailable', notFound: true }
  }
  // A cursor read is the live tail. A pagination read (`beforeOffset`) walks
  // backwards through a file whose size does not move, so it always re-reads a
  // window instead.
  if (params.knownFileSize !== undefined && params.beforeOffset === undefined) {
    if (params.knownFileSize === fileSize) {
      return { unchanged: true, fileSize }
    }
    if (params.knownFileSize < fileSize) {
      const delta = await readAppendedRecords(filePath, agent, params.knownFileSize, signal)
      if (delta) {
        return { ...delta, filePath }
      }
    }
    // Below the cursor means the file was rotated or truncated: fall through and
    // re-window it, which is what the local watcher does on the same signal.
  }
  const result = await readNativeChatTranscriptTail(
    {
      agent,
      sessionId: params.sessionId,
      filePath,
      limit: params.limit,
      ...(params.beforeOffset === undefined ? {} : { beforeOffset: params.beforeOffset })
    },
    signal
  )
  // `filePath` lets a live poller name the file it already resolved, so the next
  // tick costs one access() instead of another walk of the remote agent home.
  return 'messages' in result ? { ...result, fileSize, filePath } : result
}

/** Reads only what was written past the caller's cursor, so a live session ships
 *  new turns instead of its whole window every tick (the local watcher's
 *  `onAppend` path). Null when the agent has no decoder. */
async function readAppendedRecords(
  filePath: string,
  agent: AgentType,
  fromOffset: number,
  signal?: AbortSignal
): Promise<{
  appended: Awaited<ReturnType<typeof readIncrementalTranscriptMessages>>
  fileSize: number
  lifecycle?: NativeChatTurnLifecycle
} | null> {
  const decode = nativeChatLineDecoderForAgent(agent)
  if (!decode) {
    return null
  }
  signal?.throwIfAborted()
  const decodeLifecycle = nativeChatTurnLifecycleDecoderForAgent(agent)
  const state = {
    offset: fromOffset,
    pendingChunks: [] as Buffer[],
    pendingStart: fromOffset,
    pendingBytes: 0,
    droppingOversizedRecord: false
  }
  let lifecycle: NativeChatTurnLifecycle | undefined
  const appended = await readIncrementalTranscriptMessages(
    filePath,
    state,
    decode,
    undefined,
    decodeLifecycle ?? undefined,
    (next) => {
      lifecycle = next
    }
  )
  return {
    appended,
    // Why: this reader is stateless per request, so the pending partial line it
    // buffered is dropped when the call returns. Report the offset where that
    // line STARTS (not the bytes consumed), so the next tick re-reads it whole
    // instead of skipping a record the agent was still writing.
    fileSize: state.pendingStart,
    ...(lifecycle ? { lifecycle } : {})
  }
}

async function transcriptSize(filePath: string): Promise<number | null> {
  try {
    return (await stat(filePath)).size
  } catch {
    // The file resolved a moment ago and is gone (rotated/removed): report it as
    // a retry-worthy miss so the caller keeps polling rather than settling.
    return null
  }
}

export function normalizeSshNativeChatRelayReadParams(
  params: Record<string, unknown>
): SshNativeChatRelayReadParams {
  const agent = typeof params.agent === 'string' ? params.agent.trim() : ''
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : ''
  const rawLimit = params.limit
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), SSH_NATIVE_CHAT_READ_LIMIT_MAX)
      : 1
  const rawPath = typeof params.transcriptPath === 'string' ? params.transcriptPath.trim() : ''
  const transcriptPath =
    rawPath && rawPath.length <= SSH_NATIVE_CHAT_TRANSCRIPT_PATH_MAX_LENGTH ? rawPath : undefined
  const beforeOffset = nonNegativeInteger(params.beforeOffset)
  const knownFileSize = nonNegativeInteger(params.knownFileSize)
  return {
    agent,
    sessionId,
    limit,
    ...(transcriptPath === undefined ? {} : { transcriptPath }),
    ...(beforeOffset === undefined ? {} : { beforeOffset }),
    ...(knownFileSize === undefined ? {} : { knownFileSize })
  }
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}
