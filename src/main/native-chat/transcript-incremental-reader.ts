import type { NativeChatMessage, NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import { transcriptFallbackId } from './transcript-fallback-id'
import {
  MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES,
  type NativeChatLineDecoder
} from './transcript-tail-reader'
import type { TranscriptFileSource } from './transcript-file-source'
import { openTranscriptReadStream, wslGatedStat } from './wsl-transcript-fs-access'

const APPEND_BATCH_MESSAGE_LIMIT = 40
const INCREMENTAL_READ_CHUNK_BYTES = 64 * 1024

export type IncrementalTranscriptState = {
  offset: number
  pendingChunks: Buffer[]
  pendingStart: number
  pendingBytes: number
  droppingOversizedRecord: boolean
}

type IncrementalTranscriptReadOptions = {
  fileSource?: TranscriptFileSource
  signal?: AbortSignal
}

export function createIncrementalTranscriptState(): IncrementalTranscriptState {
  return {
    offset: 0,
    pendingChunks: [],
    pendingStart: 0,
    pendingBytes: 0,
    droppingOversizedRecord: false
  }
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
  optionsOrSignal: IncrementalTranscriptReadOptions | AbortSignal = {}
): Promise<NativeChatMessage[]> {
  const options = isAbortSignal(optionsOrSignal) ? { signal: optionsOrSignal } : optionsOrSignal
  const { fileSource, signal } = options
  const end = (
    fileSource ? await fileSource.stat(filePath) : await wslGatedStat(filePath, 'exact', signal)
  ).size
  signal?.throwIfAborted()
  if (end <= state.offset) {
    return []
  }
  const messages: NativeChatMessage[] = []
  if (fileSource) {
    await readProviderChunks(fileSource)
    return messages
  }
  const stream = openTranscriptReadStream(
    filePath,
    { start: state.offset, end: end - 1 },
    'exact',
    signal
  )
  try {
    let absoluteOffset = state.offset
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
      processChunk(chunk, absoluteOffset)
      absoluteOffset += chunk.length
      state.offset = absoluteOffset
    }
    return messages
  } finally {
    // Early exits (throw/oversized-record bail) must not leak the fd or, on
    // UNC, the gated handle the generator's finally closes.
    stream.destroy()
  }

  async function readProviderChunks(fileSource: TranscriptFileSource): Promise<void> {
    const reader = await fileSource.open(filePath)
    try {
      let absoluteOffset = state.offset
      while (absoluteOffset < end) {
        signal?.throwIfAborted()
        const requestedBytes = Math.min(INCREMENTAL_READ_CHUNK_BYTES, end - absoluteOffset)
        const chunk = await reader.read(absoluteOffset, requestedBytes)
        signal?.throwIfAborted()
        if (chunk.length === 0 || chunk.length > requestedBytes) {
          throw new Error('Transcript changed during read')
        }
        processChunk(chunk, absoluteOffset)
        absoluteOffset += chunk.length
        state.offset = absoluteOffset
      }
    } finally {
      await reader.close()
    }
  }

  function processChunk(chunk: Buffer, absoluteOffset: number): void {
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

function isAbortSignal(
  value: IncrementalTranscriptReadOptions | AbortSignal
): value is AbortSignal {
  return 'aborted' in value
}
