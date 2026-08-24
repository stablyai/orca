import type { NativeChatMessage, NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import { Readable } from 'node:stream'
import { transcriptFallbackId } from './transcript-fallback-id'
import {
  MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES,
  type NativeChatLineDecoder
} from './transcript-tail-reader'
import {
  openTranscriptReadStream,
  WSL_TRANSCRIPT_READ_CHUNK_BYTES,
  wslGatedStat
} from './wsl-transcript-fs-access'
import type { TranscriptRangeFs } from './transcript-range-fs'

const APPEND_BATCH_MESSAGE_LIMIT = 40

export type IncrementalTranscriptState = {
  offset: number
  pendingChunks: Buffer[]
  pendingStart: number
  pendingBytes: number
  droppingOversizedRecord: boolean
}

export function resetIncrementalTranscriptState(state: IncrementalTranscriptState): void {
  state.offset = 0
  state.pendingChunks.length = 0
  state.pendingStart = 0
  state.pendingBytes = 0
  state.droppingOversizedRecord = false
}

export async function readIncrementalTranscriptMessages(
  filePath: string,
  state: IncrementalTranscriptState,
  decode: NativeChatLineDecoder,
  onBatch?: (messages: NativeChatMessage[]) => void,
  decodeLifecycle?: (line: string, fallbackId: string) => NativeChatTurnLifecycle | null,
  onLifecycle?: (lifecycle: NativeChatTurnLifecycle) => void,
  signal?: AbortSignal,
  rangeFs?: TranscriptRangeFs
): Promise<NativeChatMessage[]> {
  const openingStamp = rangeFs ? await rangeFs.stat(filePath, signal, true) : null
  const end = openingStamp?.size ?? (await wslGatedStat(filePath, 'exact', signal)).size
  if (end <= state.offset) {
    return []
  }
  const messages: NativeChatMessage[] = []
  const openingState = rangeFs
    ? {
        offset: state.offset,
        pendingChunks: [...state.pendingChunks],
        pendingStart: state.pendingStart,
        pendingBytes: state.pendingBytes,
        droppingOversizedRecord: state.droppingOversizedRecord
      }
    : null
  const stagedBatches: NativeChatMessage[][] = []
  const stream = rangeFs
    ? Readable.from(rangeTranscriptChunks(rangeFs, filePath, state.offset, end - 1, signal))
    : openTranscriptReadStream(filePath, { start: state.offset, end: end - 1 }, 'exact', signal)
  try {
    let absoluteOffset = state.offset
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
      let segmentStart = 0
      let newline = chunk.indexOf(0x0a)
      while (newline >= 0) {
        retainPart(chunk.subarray(segmentStart, newline))
        if (!state.droppingOversizedRecord) {
          decodeLine()
        }
        resetPendingLine(absoluteOffset + newline + 1)
        segmentStart = newline + 1
        newline = chunk.indexOf(0x0a, segmentStart)
      }
      if (segmentStart < chunk.length) {
        retainPart(chunk.subarray(segmentStart))
      }
      absoluteOffset += chunk.length
      state.offset = absoluteOffset
    }
    if (rangeFs && openingStamp) {
      await rangeFs.assertStable(filePath, openingStamp, signal)
      for (const batch of stagedBatches) {
        onBatch?.(batch)
      }
    }
    return messages
  } catch (error) {
    if (openingState) {
      state.offset = openingState.offset
      state.pendingChunks = openingState.pendingChunks
      state.pendingStart = openingState.pendingStart
      state.pendingBytes = openingState.pendingBytes
      state.droppingOversizedRecord = openingState.droppingOversizedRecord
    }
    throw error
  } finally {
    // Early exits (throw/oversized-record bail) must not leak the fd or, on
    // UNC, the gated handle the generator's finally closes.
    stream.destroy()
  }

  function retainPart(part: Buffer): void {
    if (state.droppingOversizedRecord) {
      return
    }
    state.pendingBytes += part.length
    if (state.pendingBytes > MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES) {
      state.pendingChunks.length = 0
      state.droppingOversizedRecord = true
      return
    }
    state.pendingChunks.push(part)
  }

  function resetPendingLine(nextStart: number): void {
    state.pendingChunks.length = 0
    state.pendingBytes = 0
    state.droppingOversizedRecord = false
    state.pendingStart = nextStart
  }

  function decodeLine(): void {
    let line = Buffer.concat(state.pendingChunks).toString('utf8')
    if (line.endsWith('\r')) {
      line = line.slice(0, -1)
    }
    if (!line) {
      return
    }
    const fallbackId = transcriptFallbackId(filePath, state.pendingStart)
    const lifecycle = decodeLifecycle?.(line, fallbackId)
    if (lifecycle) {
      onLifecycle?.(lifecycle)
    }
    const message = decode(line, fallbackId)
    if (!message) {
      return
    }
    messages.push(message)
    if (onBatch && messages.length >= APPEND_BATCH_MESSAGE_LIMIT) {
      const batch = messages.splice(0)
      if (rangeFs) {
        stagedBatches.push(batch)
      } else {
        onBatch(batch)
      }
    }
  }
}

async function* rangeTranscriptChunks(
  rangeFs: TranscriptRangeFs,
  filePath: string,
  start: number,
  endInclusive: number,
  signal?: AbortSignal
): AsyncGenerator<Buffer> {
  let position = start
  while (position <= endInclusive) {
    signal?.throwIfAborted()
    const length = Math.min(WSL_TRANSCRIPT_READ_CHUNK_BYTES, endInclusive - position + 1)
    const chunk = await rangeFs.read(filePath, position, length, signal)
    if (chunk.length === 0) {
      return
    }
    yield chunk
    position += chunk.length
    if (chunk.length < length) {
      return
    }
  }
}
