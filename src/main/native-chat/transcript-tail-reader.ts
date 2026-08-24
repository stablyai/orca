import type {
  AgentType,
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../shared/native-chat-types'
import type { TranscriptRangeFs } from './transcript-range-fs'
import { readOwnedSshNativeChatTranscriptTail } from './ssh-transcript-read'
import { resolveHydratedNativeChatTranscriptOwner } from './native-chat-transcript-owner'
import { transcriptUnverifiableResult } from './transcript-host-verdict'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import { resolveSessionFilePath, type ResolveSessionFileOptions } from './session-file-resolver'
import {
  decodeClaudeTranscriptLine,
  decodeCodexTranscriptLine,
  decodeGrokTranscriptLine,
  decodeOmpTranscriptLine
} from './transcript-line-decoders'
import { transcriptFallbackId } from './transcript-fallback-id'
import {
  nativeChatTurnLifecycleDecoderForAgent,
  type NativeChatTurnLifecycleDecoder
} from './transcript-turn-lifecycle'
import {
  findLastCompleteLineEnd,
  readTranscriptByteAt,
  TAIL_CHUNK_BYTES
} from './transcript-tail-boundary'
import {
  closeTranscriptHandle,
  wslGatedOpen,
  wslGatedRead,
  wslGatedStat
} from './wsl-transcript-fs-access'
import { wslTranscriptFsRefusal } from './wsl-transcript-fs-gate'

export const MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES = 2 * 1024 * 1024

export type NativeChatLineDecoder = (line: string, fallbackId: string) => NativeChatMessage | null

export function nativeChatLineDecoderForAgent(agent: AgentType): NativeChatLineDecoder | null {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  if (transcriptAgent === 'claude') {
    return decodeClaudeTranscriptLine
  }
  if (transcriptAgent === 'codex') {
    return decodeCodexTranscriptLine
  }
  if (transcriptAgent === 'grok') {
    return decodeGrokTranscriptLine
  }
  if (transcriptAgent === 'omp') {
    return decodeOmpTranscriptLine
  }
  return null
}

export async function readNativeChatTranscriptTailFile(
  filePath: string,
  limit: number,
  decode: NativeChatLineDecoder,
  includeTrailingLine = false,
  endOffset?: number,
  decodeLifecycle?: NativeChatTurnLifecycleDecoder | null,
  signal?: AbortSignal,
  rangeFs?: TranscriptRangeFs
): Promise<{
  messages: NativeChatMessage[]
  lifecycle?: NativeChatTurnLifecycle
  consumedTo: number
  hasMore: boolean
  beforeOffset: number
  malformedRecordCount?: number
  oversizedRecordCount?: number
}> {
  signal?.throwIfAborted()
  const openingStamp = rangeFs ? await rangeFs.stat(filePath, signal, true) : null
  const end = Math.min(
    openingStamp?.size ?? (await wslGatedStat(filePath, 'exact', signal)).size,
    endOffset ?? Number.MAX_SAFE_INTEGER
  )
  signal?.throwIfAborted()
  if (end === 0) {
    return { messages: [], consumedTo: 0, hasMore: false, beforeOffset: 0 }
  }
  const handle = rangeFs ? undefined : await wslGatedOpen(filePath, 'exact', signal)
  const readChunk = async (position: number, length: number): Promise<Buffer> => {
    if (rangeFs) {
      return rangeFs.read(filePath, position, length, signal)
    }
    if (!handle) {
      return Buffer.alloc(0)
    }
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await wslGatedRead(
      handle,
      filePath,
      buffer,
      0,
      length,
      position,
      'exact',
      signal
    )
    return buffer.subarray(0, bytesRead)
  }
  const lineParts: Buffer[] = []
  let lineBytes = 0
  let lineOversized = false
  let lifecycle: NativeChatTurnLifecycle | undefined
  let malformedRecordCount = 0
  let oversizedRecordCount = 0
  let ignoreNextMalformedRecord = false
  try {
    signal?.throwIfAborted()
    const consumedTo = includeTrailingLine
      ? end
      : await findLastCompleteLineEnd(readChunk, end, signal)
    if (consumedTo === 0) {
      return { messages: [], consumedTo: 0, hasMore: false, beforeOffset: 0 }
    }
    const newestFirst: { message: NativeChatMessage; offset: number }[] = []
    const finalByte = await readTranscriptByteAt(readChunk, consumedTo - 1, signal)
    if (finalByte === null) {
      // File shrank between stat and probe: report empty, the next poll re-stats.
      return { messages: [], consumedTo: 0, hasMore: false, beforeOffset: 0 }
    }
    ignoreNextMalformedRecord = finalByte !== 0x0a
    let cursor = consumedTo - (finalByte === 0x0a ? 1 : 0)
    while (cursor > 0 && newestFirst.length <= limit) {
      signal?.throwIfAborted()
      const start = Math.max(0, cursor - TAIL_CHUNK_BYTES)
      const requestedLength = cursor - start
      const buffer = await readChunk(start, requestedLength)
      signal?.throwIfAborted()
      // A short read means the file shrank mid-walk: stop paging back rather
      // than stitch non-adjacent bytes into records.
      if (buffer.length < requestedLength) {
        break
      }
      let segmentEnd = buffer.length
      for (let index = buffer.length - 1; index >= 0 && newestFirst.length <= limit; index--) {
        if (buffer[index] !== 0x0a) {
          continue
        }
        retainPart(buffer.subarray(index + 1, segmentEnd))
        if (!lineOversized) {
          decodeLine(start + index + 1, newestFirst)
        }
        resetLine()
        segmentEnd = index
      }
      if (segmentEnd > 0) {
        retainPart(buffer.subarray(0, segmentEnd))
      }
      cursor = start
    }
    if (cursor === 0 && lineParts.length > 0 && newestFirst.length <= limit) {
      decodeLine(0, newestFirst)
    }
    const chronological = newestFirst.toReversed()
    // Why: slice(-0) returns the whole array, so a non-positive limit must
    // window to nothing explicitly rather than leak every buffered record.
    const selected = limit > 0 ? chronological.slice(Math.max(0, chronological.length - limit)) : []
    const result = {
      messages: selected.map((entry) => entry.message),
      ...(lifecycle ? { lifecycle } : {}),
      consumedTo,
      hasMore: limit > 0 && chronological.length > limit,
      beforeOffset: selected[0]?.offset ?? end,
      ...(malformedRecordCount > 0 ? { malformedRecordCount } : {}),
      ...(oversizedRecordCount > 0 ? { oversizedRecordCount } : {})
    }
    if (rangeFs && openingStamp) {
      await rangeFs.assertStable(filePath, openingStamp, signal)
    }
    return result
  } finally {
    if (handle) {
      await closeTranscriptHandle(handle, filePath)
    }
  }

  function retainPart(part: Buffer): void {
    if (lineOversized) {
      return
    }
    lineBytes += part.length
    if (lineBytes > MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES) {
      lineParts.length = 0
      lineOversized = true
      oversizedRecordCount++
      return
    }
    lineParts.push(part)
  }

  function resetLine(): void {
    lineParts.length = 0
    lineBytes = 0
    lineOversized = false
  }

  function decodeLine(
    lineOffset: number,
    messages: { message: NativeChatMessage; offset: number }[]
  ): void {
    let line = Buffer.concat([...lineParts].toReversed()).toString('utf8')
    if (line.endsWith('\r')) {
      line = line.slice(0, -1)
    }
    if (!line) {
      return
    }
    try {
      JSON.parse(line)
    } catch {
      if (ignoreNextMalformedRecord) {
        ignoreNextMalformedRecord = false
        return
      }
      malformedRecordCount++
      return
    }
    ignoreNextMalformedRecord = false
    const fallbackId = transcriptFallbackId(filePath, lineOffset)
    // Why: scan the same bounded JSONL window for provider-authored lifecycle
    // records so reconnect snapshots can replay completion without guessing
    // from the last visible assistant message.
    lifecycle ??= decodeLifecycle?.(line, fallbackId) ?? undefined
    const message = decode(line, fallbackId)
    if (message) {
      messages.push({ message, offset: lineOffset })
    }
  }
}

export type NativeChatTranscriptTailResult =
  | {
      messages: NativeChatMessage[]
      lifecycle?: NativeChatTurnLifecycle
      hasMore: boolean
      beforeOffset: number
    }
  | { error: string; notFound?: true }

export async function readNativeChatTranscriptTail(
  args: ResolveSessionFileOptions & {
    agent: AgentType
    sessionId: string
    transcriptPath?: string
    filePath?: string
    limit: number
    beforeOffset?: number
  },
  signal?: AbortSignal
): Promise<NativeChatTranscriptTailResult> {
  const owner = args.filePath
    ? ({ kind: 'legacy-local' } as const)
    : await resolveHydratedNativeChatTranscriptOwner(args, signal)
  if (owner.kind === 'unknown') {
    return transcriptUnverifiableResult()
  }
  if (owner.kind === 'ssh') {
    return readOwnedSshNativeChatTranscriptTail(owner, args, signal, {
      decode: nativeChatLineDecoderForAgent(args.agent),
      decodeLifecycle: nativeChatTurnLifecycleDecoderForAgent(args.agent),
      readTailFile: readNativeChatTranscriptTailFile
    })
  }
  const localArgs =
    owner.kind === 'local'
      ? { ...args, transcriptPath: owner.transcriptPath, wslDistro: owner.wslDistro }
      : args
  const decode = nativeChatLineDecoderForAgent(args.agent)
  const decodeLifecycle = nativeChatTurnLifecycleDecoderForAgent(args.agent)
  if (!decode) {
    return { error: 'Transcript unavailable' }
  }
  let filePath: string | null
  try {
    filePath =
      localArgs.filePath ??
      (await resolveSessionFilePath(localArgs.agent, localArgs.sessionId, localArgs, signal))
  } catch (error) {
    signal?.throwIfAborted()
    // Why: gate refusal is transient unavailability with retry guidance —
    // `notFound` would settle callers into a false "missing" state.
    return { error: wslTranscriptFsRefusal(error).message }
  }
  signal?.throwIfAborted()
  // Why: a new agent session can report its id before the first JSONL flush;
  // callers keep that miss in loading/retry rather than showing a false error.
  if (!filePath) {
    return { error: 'Transcript unavailable', notFound: true }
  }
  try {
    const result = await readNativeChatTranscriptTailFile(
      filePath,
      localArgs.limit,
      decode,
      true,
      localArgs.beforeOffset,
      decodeLifecycle,
      signal
    )
    return {
      messages: result.messages,
      // Why: an older pagination page must not rewind the live lifecycle; only
      // the current transcript tail can authoritatively describe turn state.
      ...(localArgs.beforeOffset === undefined && result.lifecycle
        ? { lifecycle: result.lifecycle }
        : {}),
      hasMore: result.hasMore,
      beforeOffset: result.beforeOffset
    }
  } catch (error) {
    signal?.throwIfAborted()
    const message = error instanceof Error ? error.message : String(error)
    return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
      ? { error: message, notFound: true }
      : { error: message }
  }
}
