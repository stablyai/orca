import { stat } from 'node:fs/promises'
import type { AgentType, NativeChatTurnLifecycle } from '../shared/native-chat-types'
import {
  SSH_NATIVE_CHAT_GENERATION_MAX_LENGTH,
  SSH_NATIVE_CHAT_READ_LIMIT_MAX,
  SSH_NATIVE_CHAT_READ_TRANSCRIPT_METHOD,
  SSH_NATIVE_CHAT_TRANSCRIPT_PATH_MAX_LENGTH,
  sshNativeChatFileIdentity,
  type SshNativeChatRelayReadParams,
  type SshNativeChatRelayReadResult
} from '../shared/ssh-native-chat-relay'
import {
  resolveSessionFilePath,
  type ResolveSessionFileOptions
} from '../main/native-chat/session-file-resolver'
import { readIncrementalTranscriptMessages } from '../main/native-chat/transcript-incremental-reader'
import {
  completedRecordEnd,
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

type TranscriptStamp = { size: number; identity: string; generation: string }

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
  const stamp = await transcriptStamp(filePath)
  if (!stamp) {
    return { error: 'Transcript unavailable', notFound: true }
  }
  // A cursor read is the live tail. A pagination read (`beforeOffset`) walks
  // backwards through a file whose size does not move, so it always re-reads a
  // window instead.
  if (params.knownFileSize !== undefined && params.beforeOffset === undefined) {
    const tail = await liveTailAnswer(filePath, agent, params, stamp, signal)
    if (tail) {
      return tail
    }
    // Anything else (a shrunk file, a same-length rewrite, a rotated inode)
    // falls through and re-windows, which is what the local watcher does on the
    // same signal.
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
  if (!('messages' in result)) {
    return result
  }
  // Why: the reader re-stats and reads to the CURRENT end, so a record can land
  // between the stamp above and the read. Stamping after the read keeps the
  // cursor, the generation and the returned messages describing one state; the
  // earlier stamp would report an mtime older than the content and make the next
  // poll see a same-size-different-generation file and re-window for nothing.
  const after = (await transcriptStamp(filePath)) ?? stamp
  // A window read includes a half-written trailing record, which decodes to
  // nothing. Handing back the raw file end as the cursor would resume the next
  // incremental read mid-record and lose that record once its newline lands, so
  // the cursor stops at the last complete record instead. A pagination read has
  // no live cursor to protect, so it skips that probe.
  const cursor =
    params.beforeOffset === undefined ? await windowCursor(filePath, after.size) : after.size
  if (cursor === null) {
    // The file went away between the read and the cursor probe (a rotation).
    // Report the same retry-worthy miss as every other rotation in here, rather
    // than throwing and having the caller count it as relay silence.
    return { error: 'Transcript unavailable', notFound: true }
  }
  // `filePath` lets a live poller name the file it already resolved, so the next
  // tick costs one access() instead of another walk of the remote agent home.
  return { ...result, fileSize: cursor, filePath, generation: after.generation }
}

/** Answers a live poll without re-windowing, or null when the file moved in a
 *  way only a full window can describe. */
async function liveTailAnswer(
  filePath: string,
  agent: AgentType,
  params: SshNativeChatRelayReadParams,
  stamp: TranscriptStamp,
  signal?: AbortSignal
): Promise<SshNativeChatRelayReadResult | null> {
  const knownIdentity = sshNativeChatFileIdentity(params.generation)
  if (knownIdentity && knownIdentity !== stamp.identity) {
    // A different inode behind the same path: the transcript was rotated or
    // replaced, so its size says nothing about what the caller holds.
    return null
  }
  if (params.knownFileSize === stamp.size) {
    // Same length can still mean different content (a truncate-and-rewrite), so
    // an unchanged answer needs the mtime half of the stamp to agree too. A host
    // that sends no generation keeps the older size-only behavior.
    if (params.generation !== undefined && params.generation !== stamp.generation) {
      return null
    }
    return { unchanged: true, fileSize: stamp.size, generation: stamp.generation }
  }
  if (params.knownFileSize !== undefined && params.knownFileSize < stamp.size) {
    const delta = await readAppendedRecords(filePath, agent, params.knownFileSize, signal)
    if (delta) {
      // Stamp after the read for the same reason the window path does.
      const after = (await transcriptStamp(filePath)) ?? stamp
      return { ...delta, filePath, generation: after.generation }
    }
  }
  return null
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

/** Null when the file vanished under the probe, so the caller can report a miss
 *  instead of rejecting the whole RPC. */
async function windowCursor(filePath: string, size: number): Promise<number | null> {
  try {
    return await completedRecordEnd(filePath, size)
  } catch {
    return null
  }
}

async function transcriptStamp(filePath: string): Promise<TranscriptStamp | null> {
  try {
    const stats = await stat(filePath)
    const identity = `${stats.dev}:${stats.ino}`
    return { size: stats.size, identity, generation: `${identity}:${stats.mtimeMs}` }
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
  const transcriptPath = boundedString(
    params.transcriptPath,
    SSH_NATIVE_CHAT_TRANSCRIPT_PATH_MAX_LENGTH
  )
  const generation = boundedString(params.generation, SSH_NATIVE_CHAT_GENERATION_MAX_LENGTH)
  const beforeOffset = nonNegativeInteger(params.beforeOffset)
  const knownFileSize = nonNegativeInteger(params.knownFileSize)
  return {
    agent,
    sessionId,
    limit,
    ...(transcriptPath === undefined ? {} : { transcriptPath }),
    ...(beforeOffset === undefined ? {} : { beforeOffset }),
    ...(knownFileSize === undefined ? {} : { knownFileSize }),
    ...(generation === undefined ? {} : { generation })
  }
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}
