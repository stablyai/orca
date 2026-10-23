/**
 * Surrogate-safe splitting for daemon stream data events: NDJSON line-size
 * chunking (the receiver's parser rejects oversized lines) and the safe-index
 * clamp shared by the batcher's bulk write slicing and keep-tail dropping.
 */
import { resolveSynchronizedOutputSafeSplit } from '../../shared/terminal-synchronized-output-scan'
import {
  BINARY_STREAM_FRAMING,
  binaryStreamDataFrameOverheadBytes,
  encodeBinaryStreamDataFrame,
  encodeBinaryStreamEventFrame,
  type DaemonStreamFraming,
  type StreamDataPayloadMeta
} from './daemon-stream-binary-framing'
import { encodeNdjson } from './ndjson'

export type StreamWriteChunk = string | Buffer

export function encodeStreamDataEvent(
  sessionId: string,
  data: string,
  rawLength?: number,
  seq?: number,
  transformed?: boolean
): string {
  return encodeNdjson({
    type: 'event',
    event: 'data',
    sessionId,
    payload: {
      data,
      ...(seq === undefined ? {} : { seq }),
      ...(rawLength === undefined ? {} : { rawLength }),
      ...(rawLength === undefined ? {} : { sequenceChars: rawLength }),
      ...(transformed ? { transformed: true } : {})
    }
  })
}

function streamDataEventLineBytes(sessionId: string, data: string, rawLength?: number): number {
  return Buffer.byteLength(encodeStreamDataEvent(sessionId, data, rawLength), 'utf8')
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff
}

/**
 * Bulk-write split policy: frame-align first so a held remainder cannot strand an
 * open DEC 2026 frame's closing \x1b[?2026l (xterm then stops repainting until its
 * 1s timeout), then let the surrogate clamp have the final say.
 */
export function clampToSafeBulkWriteSplitIndex(value: string, end: number): number {
  // Math.max(1): the surrogate clamp can decrement an aligned index to 0 (e.g.
  // ('\u{1F600}aaaa', 1)), and a 0-length slice would never shift the batcher's
  // queue entry, spinning its drain loop.
  return Math.max(
    1,
    clampToSafeSplitIndex(value, 0, resolveSynchronizedOutputSafeSplit(value, end))
  )
}

export function clampToSafeSplitIndex(value: string, start: number, end: number): number {
  if (end <= start || end >= value.length) {
    return end
  }
  const prev = value.charCodeAt(end - 1)
  const next = value.charCodeAt(end)
  return isHighSurrogate(prev) && isLowSurrogate(next) ? end - 1 : end
}

function nextSafeSplitIndex(value: string, start: number): number {
  const next = Math.min(value.length, start + 1)
  if (
    next < value.length &&
    isHighSurrogate(value.charCodeAt(start)) &&
    isLowSurrogate(value.charCodeAt(next))
  ) {
    return next + 1
  }
  return next
}

export function splitStreamDataForNdjson(
  sessionId: string,
  data: string,
  maxLineBytes: number,
  sequenceChars?: number
): string[] {
  if (streamDataEventLineBytes(sessionId, data, sequenceChars) <= maxLineBytes) {
    return [data]
  }

  return splitOversizedStreamDataForNdjson(sessionId, data, maxLineBytes, sequenceChars)
}

function splitOversizedStreamDataForNdjson(
  sessionId: string,
  data: string,
  maxLineBytes: number,
  sequenceChars?: number
): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < data.length) {
    let low = start + 1
    let high = data.length
    let best = start

    while (low <= high) {
      const rawMid = Math.floor((low + high) / 2)
      const mid = clampToSafeSplitIndex(data, start, rawMid)
      if (mid <= start) {
        low = rawMid + 1
        continue
      }

      if (
        streamDataEventLineBytes(sessionId, data.slice(start, mid), sequenceChars) <= maxLineBytes
      ) {
        best = mid
        low = rawMid + 1
      } else {
        high = rawMid - 1
      }
    }

    const end = best > start ? best : nextSafeSplitIndex(data, start)
    chunks.push(data.slice(start, end))
    start = end
  }

  return chunks
}

function dataPayloadMeta(
  rawLength: number | undefined,
  seq: number | undefined,
  transformed: boolean
): StreamDataPayloadMeta {
  return {
    ...(seq === undefined ? {} : { seq }),
    ...(rawLength === undefined ? {} : { rawLength, sequenceChars: rawLength }),
    ...(transformed ? { transformed: true } : {})
  }
}

// Mirrors the NDJSON writer's per-chunk seq/rawLength rules; only the size budget differs, and raw
// bytes need no binary search because one UTF-16 unit never encodes to more than 3 UTF-8 bytes.
function writeBinaryStreamDataEvents(
  streamSocket: { write(data: StreamWriteChunk): void },
  sessionId: string,
  data: string,
  maxFrameBytes: number,
  rawLength: number,
  seq: number | undefined,
  transformed: boolean
): void {
  const explicitRawLength = rawLength === data.length ? undefined : rawLength
  if (transformed) {
    streamSocket.write(
      encodeBinaryStreamDataFrame(sessionId, data, dataPayloadMeta(rawLength, seq, true))
    )
    return
  }
  const carriesMetadata = explicitRawLength !== undefined || seq !== undefined
  const whole = encodeBinaryStreamDataFrame(
    sessionId,
    data,
    dataPayloadMeta(
      explicitRawLength === 0 ? 0 : carriesMetadata ? data.length : undefined,
      seq,
      false
    ),
    maxFrameBytes
  )
  if (whole !== null) {
    streamSocket.write(whole)
    return
  }
  const worstCaseOverhead = binaryStreamDataFrameOverheadBytes(
    sessionId,
    carriesMetadata ? dataPayloadMeta(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, false) : {}
  )
  const dataBudgetBytes = Math.max(3, maxFrameBytes - worstCaseOverhead)
  // JSON fallback must budget escaped bytes with the existing splitter.
  const jsonChunks = data.isWellFormed()
    ? undefined
    : splitStreamDataForNdjson(sessionId, data, Math.max(1, maxFrameBytes - 96), explicitRawLength)
  const chunkChars = Math.max(1, Math.floor(dataBudgetBytes / 3))
  let chunkIndex = 0
  let start = 0
  do {
    const end = jsonChunks
      ? start + jsonChunks[chunkIndex++].length
      : Math.max(
          nextSafeSplitIndex(data, start),
          clampToSafeSplitIndex(data, start, Math.min(data.length, start + chunkChars))
        )
    const chunk = data.slice(start, end)
    start = end
    const chunkEndSeq = seq === undefined ? undefined : seq - (data.length - start)
    const chunkRawLength = explicitRawLength === 0 ? 0 : carriesMetadata ? chunk.length : undefined
    streamSocket.write(
      encodeBinaryStreamDataFrame(
        sessionId,
        chunk,
        dataPayloadMeta(chunkRawLength, chunkEndSeq, false)
      )
    )
  } while (start < data.length)
}

export function writeStreamDataEvents(
  streamSocket: { write(data: string): void },
  sessionId: string,
  data: string,
  maxLineBytes: number,
  rawLength = data.length,
  seq?: number,
  transformed = false
): void {
  const explicitRawLength = rawLength === data.length ? undefined : rawLength
  if (transformed) {
    streamSocket.write(encodeStreamDataEvent(sessionId, data, rawLength, seq, true))
    return
  }
  const carriesMetadata = explicitRawLength !== undefined || seq !== undefined
  let chunks: string[]
  if (!carriesMetadata) {
    const line = encodeStreamDataEvent(sessionId, data)
    if (Buffer.byteLength(line, 'utf8') <= maxLineBytes) {
      streamSocket.write(line)
      return
    }
    chunks = splitOversizedStreamDataForNdjson(sessionId, data, maxLineBytes)
  } else {
    chunks = splitStreamDataForNdjson(
      sessionId,
      data,
      Math.max(1, maxLineBytes - 96),
      explicitRawLength
    )
  }
  let consumed = 0
  for (const chunk of chunks) {
    consumed += chunk.length
    const chunkEndSeq = seq === undefined ? undefined : seq - (data.length - consumed)
    const chunkRawLength = explicitRawLength === 0 ? 0 : carriesMetadata ? chunk.length : undefined
    streamSocket.write(encodeStreamDataEvent(sessionId, chunk, chunkRawLength, chunkEndSeq))
  }
}

/** How a stream socket's events become bytes; chosen per socket by its hello. */
export type StreamFrames = {
  control(event: unknown): StreamWriteChunk
  /** An empty data event: a real frame, so its write completes only after those queued before it. */
  noop(sessionId: string): StreamWriteChunk
  data(
    streamSocket: { write(data: StreamWriteChunk): void },
    sessionId: string,
    data: string,
    maxLineBytes: number,
    rawLength?: number,
    seq?: number,
    transformed?: boolean
  ): void
}

const NDJSON_STREAM_FRAMES: StreamFrames = {
  control: (event) => encodeNdjson(event),
  noop: (sessionId) => encodeStreamDataEvent(sessionId, ''),
  data: writeStreamDataEvents
}

const BINARY_STREAM_FRAMES: StreamFrames = {
  control: (event) => encodeBinaryStreamEventFrame(event),
  noop: (sessionId) => encodeBinaryStreamDataFrame(sessionId, ''),
  data: (streamSocket, sessionId, data, maxLineBytes, rawLength = data.length, seq, transformed) =>
    writeBinaryStreamDataEvents(
      streamSocket,
      sessionId,
      data,
      maxLineBytes,
      rawLength,
      seq,
      transformed === true
    )
}

export function streamFramesFor(framing: DaemonStreamFraming = 'ndjson'): StreamFrames {
  return framing === BINARY_STREAM_FRAMING ? BINARY_STREAM_FRAMES : NDJSON_STREAM_FRAMES
}
