import { open, stat } from 'node:fs/promises'
import type {
  AgentType,
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../shared/native-chat-types'
import { resolveSessionFilePath, type ResolveSessionFileOptions } from './session-file-resolver'
import {
  nativeChatLineDecoderForAgent,
  nativeChatLineDecoderForTranscript,
  type NativeChatLineDecoder
} from './transcript-line-decoder-resolver'
import { transcriptFallbackId } from './transcript-fallback-id'
import {
  consumeCodexTextMirror,
  isCodexTranscriptDecoder,
  mergeCodexTextMirrorMessages,
  type CodexTextMirrorRecord
} from './transcript-codex-mirror'
import {
  nativeChatTurnLifecycleDecoderForAgent,
  type NativeChatTurnLifecycleDecoder
} from './transcript-turn-lifecycle'
import { findLastCompleteLineEnd, TAIL_CHUNK_BYTES } from './transcript-tail-file-end'

export const MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES = 2 * 1024 * 1024

export { nativeChatLineDecoderForAgent, nativeChatLineDecoderForTranscript }
export type { NativeChatLineDecoder }

export async function readNativeChatTranscriptTailFile(
  filePath: string,
  limit: number,
  decode: NativeChatLineDecoder,
  includeTrailingLine = false,
  endOffset?: number,
  decodeLifecycle?: NativeChatTurnLifecycleDecoder | null,
  signal?: AbortSignal
): Promise<{
  messages: NativeChatMessage[]
  lifecycle?: NativeChatTurnLifecycle
  consumedTo: number
  hasMore: boolean
  beforeOffset: number
  malformedRecordCount?: number
  oversizedRecordCount?: number
  lastCodexRecord?: CodexTextMirrorRecord | null
  lastCodexMessage?: NativeChatMessage | null
}> {
  signal?.throwIfAborted()
  const deduplicateCodexMirrors = isCodexTranscriptDecoder(decode)
  const end = Math.min((await stat(filePath)).size, endOffset ?? Number.MAX_SAFE_INTEGER)
  signal?.throwIfAborted()
  if (end === 0) {
    return { messages: [], consumedTo: 0, hasMore: false, beforeOffset: 0 }
  }
  const handle = await open(filePath, 'r')
  const lineParts: Buffer[] = []
  let lineBytes = 0
  let lineOversized = false
  let lifecycle: NativeChatTurnLifecycle | undefined
  let malformedRecordCount = 0
  let oversizedRecordCount = 0
  let ignoreNextMalformedRecord = false
  let previousCodexRecord: CodexTextMirrorRecord | null = null
  let previousCodexMessage: NativeChatMessage | null = null
  let capturedLastRecord = false
  let resolvedLastRecordPair = false
  let lastCodexRecord: CodexTextMirrorRecord | null = null
  let lastCodexMessage: NativeChatMessage | null = null
  try {
    signal?.throwIfAborted()
    const consumedTo = includeTrailingLine
      ? end
      : await findLastCompleteLineEnd(handle, end, signal)
    if (consumedTo === 0) {
      return { messages: [], consumedTo: 0, hasMore: false, beforeOffset: 0 }
    }
    const newestFirst: { message: NativeChatMessage; offset: number }[] = []
    const finalByte = Buffer.allocUnsafe(1)
    await handle.read(finalByte, 0, 1, consumedTo - 1)
    signal?.throwIfAborted()
    ignoreNextMalformedRecord = finalByte[0] !== 0x0a
    let cursor = consumedTo - (finalByte[0] === 0x0a ? 1 : 0)
    while (cursor > 0 && newestFirst.length <= limit) {
      signal?.throwIfAborted()
      const start = Math.max(0, cursor - TAIL_CHUNK_BYTES)
      const buffer = Buffer.allocUnsafe(cursor - start)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
      signal?.throwIfAborted()
      let segmentEnd = bytesRead
      for (let index = bytesRead - 1; index >= 0 && newestFirst.length <= limit; index--) {
        if (buffer[index] !== 0x0a) {
          continue
        }
        retainPart(buffer.subarray(index + 1, segmentEnd))
        if (!lineOversized) {
          decodeLine(start + index + 1, newestFirst)
        } else if (deduplicateCodexMirrors) {
          previousCodexRecord = null
          previousCodexMessage = null
          if (!capturedLastRecord) {
            capturedLastRecord = true
          } else if (!resolvedLastRecordPair) {
            resolvedLastRecordPair = true
          }
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
    return {
      messages: selected.map((entry) => entry.message),
      ...(lifecycle ? { lifecycle } : {}),
      consumedTo,
      hasMore: limit > 0 && chronological.length > limit,
      beforeOffset: selected[0]?.offset ?? end,
      ...(malformedRecordCount > 0 ? { malformedRecordCount } : {}),
      ...(oversizedRecordCount > 0 ? { oversizedRecordCount } : {}),
      ...(deduplicateCodexMirrors ? { lastCodexRecord, lastCodexMessage } : {})
    }
  } finally {
    await handle.close()
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
      previousCodexRecord = null
      previousCodexMessage = null
      if (deduplicateCodexMirrors) {
        if (!capturedLastRecord) {
          capturedLastRecord = true
        } else if (!resolvedLastRecordPair) {
          resolvedLastRecordPair = true
        }
      }
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
    const previousRecord = previousCodexRecord
    const previousMessage = previousCodexMessage
    const mirror = deduplicateCodexMirrors ? consumeCodexTextMirror(previousRecord, line) : null
    if (mirror) {
      previousCodexRecord = mirror.current
      previousCodexMessage = mirror.duplicate ? null : message
      if (!capturedLastRecord) {
        capturedLastRecord = true
        lastCodexRecord = mirror.candidate
        lastCodexMessage = message
      } else if (!resolvedLastRecordPair) {
        resolvedLastRecordPair = true
        if (mirror.duplicate) {
          // The newest two physical records form one consumed pair, so no raw
          // mirror candidate remains pending at EOF for the incremental reader.
          lastCodexRecord = null
          lastCodexMessage = null
        }
      }
    }
    if (mirror?.duplicate) {
      const merged = mergeCodexTextMirrorMessages(
        mirror.candidate,
        message,
        previousRecord,
        previousMessage
      )
      const retained = messages.at(-1)
      if (merged && retained && previousMessage && retained.message.id === previousMessage.id) {
        retained.message = merged
        // Reverse scan: the current record is the older physical edge and must
        // own both stable identity and the pagination cursor.
        retained.offset = lineOffset
      } else if (merged) {
        messages.push({ message: merged, offset: lineOffset })
      }
    } else if (message) {
      messages.push({ message, offset: lineOffset })
    }
  }
}

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
): Promise<
  | {
      messages: NativeChatMessage[]
      lifecycle?: NativeChatTurnLifecycle
      hasMore: boolean
      beforeOffset: number
    }
  | { error: string; notFound?: true }
> {
  const decodeLifecycle = nativeChatTurnLifecycleDecoderForAgent(args.agent)
  const filePath =
    args.filePath ?? (await resolveSessionFilePath(args.agent, args.sessionId, args, signal))
  signal?.throwIfAborted()
  // Why: a new agent session can report its id before the first JSONL flush;
  // callers keep that miss in loading/retry rather than showing a false error.
  if (!filePath) {
    return { error: 'Transcript unavailable', notFound: true }
  }
  try {
    const decode = await nativeChatLineDecoderForTranscript(args.agent, filePath)
    if (!decode) {
      return { error: 'Transcript unavailable' }
    }
    const result = await readNativeChatTranscriptTailFile(
      filePath,
      args.limit,
      decode,
      true,
      args.beforeOffset,
      decodeLifecycle,
      signal
    )
    signal?.throwIfAborted()
    return {
      messages: result.messages,
      // Why: an older pagination page must not rewind the live lifecycle; only
      // the current transcript tail can authoritatively describe turn state.
      ...(args.beforeOffset === undefined && result.lifecycle
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
