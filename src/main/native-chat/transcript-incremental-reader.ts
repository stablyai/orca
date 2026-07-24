import { open, stat } from 'node:fs/promises'
import type { NativeChatMessage, NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import { transcriptFallbackId } from './transcript-fallback-id'
import { TranscriptRecordBuffer } from './transcript-record-buffer'
import {
  MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES,
  type NativeChatLineDecoder
} from './transcript-tail-reader'
import {
  estimateTranscriptMessageRetainedBytes,
  TranscriptMessageRetention
} from './transcript-message-retention'

export const APPEND_BATCH_MESSAGE_LIMIT = 40
export const APPEND_BATCH_RETAINED_BYTE_LIMIT = 8 * 1024 * 1024
export const INCREMENTAL_DRAIN_RETAINED_BYTE_LIMIT = 32 * 1024 * 1024

export type IncrementalTranscriptState = {
  offset: number
  pendingRecord: TranscriptRecordBuffer
  pendingStart: number
}

export function createIncrementalTranscriptState(): IncrementalTranscriptState {
  return {
    offset: 0,
    pendingRecord: new TranscriptRecordBuffer(MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES),
    pendingStart: 0
  }
}

export function resetIncrementalTranscriptState(state: IncrementalTranscriptState): void {
  state.offset = 0
  state.pendingRecord.clear()
  state.pendingStart = 0
}

export async function readIncrementalTranscriptMessages(
  filePath: string,
  state: IncrementalTranscriptState,
  decode: NativeChatLineDecoder,
  onBatch?: (messages: NativeChatMessage[]) => void,
  decodeLifecycle?: (line: string, fallbackId: string) => NativeChatTurnLifecycle | null,
  onLifecycle?: (lifecycle: NativeChatTurnLifecycle) => void,
  options: { maxDrainRetainedBytes?: number } = {}
): Promise<NativeChatMessage[]> {
  const end = (await stat(filePath)).size
  if (end <= state.offset) {
    return []
  }
  const messages: NativeChatMessage[] = []
  let messageBatchBytes = 0
  let drainRetainedBytes = 0
  const requestedDrainLimit = options.maxDrainRetainedBytes
  const maxDrainRetainedBytes =
    Number.isSafeInteger(requestedDrainLimit) && (requestedDrainLimit ?? 0) > 0
      ? Math.min(INCREMENTAL_DRAIN_RETAINED_BYTE_LIMIT, requestedDrainLimit ?? 0)
      : INCREMENTAL_DRAIN_RETAINED_BYTE_LIMIT
  const retainedSnapshot = onBatch ? null : new TranscriptMessageRetention()
  const handle = await open(filePath, 'r')
  try {
    const stream = handle.createReadStream({ start: state.offset, end: end - 1, autoClose: false })
    let absoluteOffset = state.offset
    streamChunks: for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
      let segmentStart = 0
      let newline = chunk.indexOf(0x0a)
      while (newline >= 0) {
        retainPart(chunk.subarray(segmentStart, newline))
        if (!state.pendingRecord.isOversized && !decodeLine()) {
          const retryOffset = state.pendingStart
          resetPendingLine(retryOffset)
          state.offset = retryOffset
          break streamChunks
        }
        const nextOffset = absoluteOffset + newline + 1
        resetPendingLine(nextOffset)
        state.offset = nextOffset
        segmentStart = newline + 1
        newline = chunk.indexOf(0x0a, segmentStart)
      }
      if (segmentStart < chunk.length) {
        retainPart(chunk.subarray(segmentStart))
      }
      absoluteOffset += chunk.length
      state.offset = absoluteOffset
    }
    return retainedSnapshot?.values() ?? messages
  } finally {
    await handle.close()
  }

  function retainPart(part: Buffer): void {
    state.pendingRecord.append(part)
  }

  function resetPendingLine(nextStart: number): void {
    state.pendingRecord.clear()
    state.pendingStart = nextStart
  }

  function decodeLine(): boolean {
    let line = state.pendingRecord.toString()
    if (line.endsWith('\r')) {
      line = line.slice(0, -1)
    }
    if (!line) {
      return true
    }
    const fallbackId = transcriptFallbackId(filePath, state.pendingStart)
    const message = decode(line, fallbackId)
    const estimatedBytes = message
      ? estimateTranscriptMessageRetainedBytes(state.pendingRecord.byteLength)
      : 0
    if (
      message &&
      onBatch &&
      drainRetainedBytes > 0 &&
      estimatedBytes > maxDrainRetainedBytes - drainRetainedBytes
    ) {
      // Why: a budget below one bounded record must still advance instead of
      // retrying that record forever.
      return false
    }
    const lifecycle = decodeLifecycle?.(line, fallbackId)
    if (lifecycle) {
      onLifecycle?.(lifecycle)
    }
    if (!message) {
      return true
    }
    if (retainedSnapshot) {
      retainedSnapshot.add(message, state.pendingRecord.byteLength)
      return true
    }
    drainRetainedBytes += estimatedBytes
    if (
      onBatch &&
      messages.length > 0 &&
      estimatedBytes > APPEND_BATCH_RETAINED_BYTE_LIMIT - messageBatchBytes
    ) {
      onBatch(messages.splice(0))
      messageBatchBytes = 0
    }
    messages.push(message)
    messageBatchBytes += estimatedBytes
    if (onBatch && messages.length >= APPEND_BATCH_MESSAGE_LIMIT) {
      onBatch(messages.splice(0))
      messageBatchBytes = 0
    }
    return true
  }
}
