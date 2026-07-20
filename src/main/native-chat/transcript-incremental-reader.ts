import { open, stat } from 'node:fs/promises'
import type { NativeChatMessage, NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import { transcriptFallbackId } from './transcript-fallback-id'
import {
  MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES,
  type NativeChatLineDecoder
} from './transcript-tail-reader'

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
  onLifecycle?: (lifecycle: NativeChatTurnLifecycle) => void
): Promise<NativeChatMessage[]> {
  const end = (await stat(filePath)).size
  if (end <= state.offset) {
    return []
  }
  const messages: NativeChatMessage[] = []
  const handle = await open(filePath, 'r')
  try {
    const stream = handle.createReadStream({ start: state.offset, end: end - 1, autoClose: false })
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
    return messages
  } finally {
    await handle.close()
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
      onBatch(messages.splice(0))
    }
  }
}
