import type { NativeChatMessage, NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import { transcriptFallbackId } from './transcript-fallback-id'
import {
  MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES,
  type NativeChatLineDecoder
} from './transcript-tail-reader'
import { openTranscriptReadStream, wslGatedStat } from './wsl-transcript-fs-access'

const APPEND_BATCH_MESSAGE_LIMIT = 40

export type IncrementalTranscriptState = {
  offset: number
  pendingChunks: Buffer[]
  pendingStart: number
  pendingBytes: number
  droppingOversizedRecord: boolean
  /** The first bytes of the record being dropped, for readers that inspect its envelope. */
  oversizedHead: Buffer | null
}

export function createIncrementalTranscriptState(): IncrementalTranscriptState {
  return {
    offset: 0,
    pendingChunks: [],
    pendingStart: 0,
    pendingBytes: 0,
    droppingOversizedRecord: false,
    oversizedHead: null
  }
}

export function resetIncrementalTranscriptState(state: IncrementalTranscriptState): void {
  state.offset = 0
  state.pendingChunks.length = 0
  state.pendingStart = 0
  state.pendingBytes = 0
  state.droppingOversizedRecord = false
  state.oversizedHead = null
}

/** Sees the head of each record dropped for size (it is never decoded). */
export type OversizedTranscriptRecordObserver = (head: Buffer, fallbackId: string) => void

/** Head bytes kept from a dropped record. */
const OVERSIZED_RECORD_HEAD_BYTES = 4096

export async function readIncrementalTranscriptMessages(
  filePath: string,
  state: IncrementalTranscriptState,
  decode: NativeChatLineDecoder,
  onBatch?: (messages: NativeChatMessage[]) => void,
  decodeLifecycle?: (line: string, fallbackId: string) => NativeChatTurnLifecycle | null,
  onLifecycle?: (lifecycle: NativeChatTurnLifecycle) => void,
  signal?: AbortSignal,
  onOversizedRecord?: OversizedTranscriptRecordObserver
): Promise<NativeChatMessage[]> {
  const end = (await wslGatedStat(filePath, 'exact', signal)).size
  if (end <= state.offset) {
    return []
  }
  const messages: NativeChatMessage[] = []
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
      let segmentStart = 0
      let newline = chunk.indexOf(0x0a)
      while (newline >= 0) {
        retainPart(chunk.subarray(segmentStart, newline))
        if (!state.droppingOversizedRecord) {
          decodeLine()
        } else if (state.oversizedHead) {
          onOversizedRecord?.(
            state.oversizedHead,
            transcriptFallbackId(filePath, state.pendingStart)
          )
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
      // Copies only the head: a sliced join would pin the whole record until its line ends.
      state.oversizedHead = onOversizedRecord
        ? Buffer.concat([...state.pendingChunks, part], OVERSIZED_RECORD_HEAD_BYTES)
        : null
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
    state.oversizedHead = null
    state.pendingStart = nextStart
  }

  function decodeLine(): void {
    // These owned bytes are decoded synchronously; a single part needs no copy.
    const bytes =
      state.pendingChunks.length === 1 ? state.pendingChunks[0] : Buffer.concat(state.pendingChunks)
    let line = bytes.toString('utf8')
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

/** Incremental read that also reports the newest turn lifecycle record it passed. */
export async function readIncrementalTranscriptWithLifecycle(
  filePath: string,
  state: IncrementalTranscriptState,
  decode: NativeChatLineDecoder,
  decodeLifecycle: ((line: string, fallbackId: string) => NativeChatTurnLifecycle | null) | null,
  signal: AbortSignal,
  onBatch?: (messages: NativeChatMessage[]) => void,
  onOversizedRecord?: OversizedTranscriptRecordObserver
): Promise<{ messages: NativeChatMessage[]; lifecycle?: NativeChatTurnLifecycle }> {
  let lifecycle: NativeChatTurnLifecycle | undefined
  const messages = await readIncrementalTranscriptMessages(
    filePath,
    state,
    decode,
    onBatch,
    decodeLifecycle ?? undefined,
    (nextLifecycle) => {
      lifecycle = nextLifecycle
    },
    signal,
    onOversizedRecord
  )
  return lifecycle ? { messages, lifecycle } : { messages }
}
