import { open, stat } from 'node:fs/promises'
import type {
  AgentType,
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../shared/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import { resolveSessionFilePath, type ResolveSessionFileOptions } from './session-file-resolver'
import {
  decodeClaudeTranscriptLine,
  decodeCodexTranscriptLine,
  decodeGrokTranscriptLine
} from './transcript-line-decoders'
import { transcriptFallbackId } from './transcript-fallback-id'
import {
  nativeChatTurnLifecycleDecoderForAgent,
  type NativeChatTurnLifecycleDecoder
} from './transcript-turn-lifecycle'

export const MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES = 2 * 1024 * 1024
const TAIL_CHUNK_BYTES = 64 * 1024

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
  return null
}

export async function readNativeChatTranscriptTailFile(
  filePath: string,
  limit: number,
  decode: NativeChatLineDecoder,
  includeTrailingLine = false,
  endOffset?: number,
  decodeLifecycle?: NativeChatTurnLifecycleDecoder | null
): Promise<{
  messages: NativeChatMessage[]
  lifecycle?: NativeChatTurnLifecycle
  consumedTo: number
  hasMore: boolean
  beforeOffset: number
}> {
  const end = Math.min((await stat(filePath)).size, endOffset ?? Number.MAX_SAFE_INTEGER)
  if (end === 0) {
    return { messages: [], consumedTo: 0, hasMore: false, beforeOffset: 0 }
  }
  const handle = await open(filePath, 'r')
  const lineParts: Buffer[] = []
  let lineBytes = 0
  let lineOversized = false
  let lifecycle: NativeChatTurnLifecycle | undefined
  try {
    const consumedTo = includeTrailingLine ? end : await findLastCompleteLineEnd(handle, end)
    if (consumedTo === 0) {
      return { messages: [], consumedTo: 0, hasMore: false, beforeOffset: 0 }
    }
    const newestFirst: { message: NativeChatMessage; offset: number }[] = []
    const finalByte = Buffer.allocUnsafe(1)
    await handle.read(finalByte, 0, 1, consumedTo - 1)
    let cursor = consumedTo - (finalByte[0] === 0x0a ? 1 : 0)
    while (cursor > 0 && newestFirst.length <= limit) {
      const start = Math.max(0, cursor - TAIL_CHUNK_BYTES)
      const buffer = Buffer.allocUnsafe(cursor - start)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
      let segmentEnd = bytesRead
      for (let index = bytesRead - 1; index >= 0 && newestFirst.length <= limit; index--) {
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
    return {
      messages: selected.map((entry) => entry.message),
      ...(lifecycle ? { lifecycle } : {}),
      consumedTo,
      hasMore: limit > 0 && chronological.length > limit,
      beforeOffset: selected[0]?.offset ?? end
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

async function findLastCompleteLineEnd(
  handle: Awaited<ReturnType<typeof open>>,
  end: number
): Promise<number> {
  const lastByte = Buffer.allocUnsafe(1)
  await handle.read(lastByte, 0, 1, end - 1)
  if (lastByte[0] === 0x0a) {
    return end
  }
  let cursor = end
  while (cursor > 0) {
    const start = Math.max(0, cursor - TAIL_CHUNK_BYTES)
    const buffer = Buffer.allocUnsafe(cursor - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    const newline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a)
    if (newline >= 0) {
      return start + newline + 1
    }
    cursor = start
  }
  return 0
}

export async function readNativeChatTranscriptTail(
  args: ResolveSessionFileOptions & {
    agent: AgentType
    sessionId: string
    transcriptPath?: string
    filePath?: string
    limit: number
    beforeOffset?: number
  }
): Promise<
  | {
      messages: NativeChatMessage[]
      lifecycle?: NativeChatTurnLifecycle
      hasMore: boolean
      beforeOffset: number
    }
  | { error: string; notFound?: true }
> {
  const decode = nativeChatLineDecoderForAgent(args.agent)
  const decodeLifecycle = nativeChatTurnLifecycleDecoderForAgent(args.agent)
  const filePath = args.filePath ?? (await resolveSessionFilePath(args.agent, args.sessionId, args))
  if (!decode) {
    return { error: 'Transcript unavailable' }
  }
  // Why: a new agent session can report its id before the first JSONL flush;
  // callers keep that miss in loading/retry rather than showing a false error.
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
      decodeLifecycle
    )
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
    const message = error instanceof Error ? error.message : String(error)
    return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
      ? { error: message, notFound: true }
      : { error: message }
  }
}
