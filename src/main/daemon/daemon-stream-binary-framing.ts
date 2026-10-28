/**
 * Negotiated binary framing carries raw UTF-8 data; older peers retain NDJSON.
 * Frame: [kind u8][body length u32 BE][body].
 * EVENT body: UTF-8 JSON; DATA body: [meta length u16 BE][meta JSON][data bytes].
 * DATA metadata omits payload.data, which the reader restores from the bytes.
 */
import { NDJSON_MAX_LINE_BYTES } from './ndjson'
import type { DaemonEvent } from './types'

export const BINARY_STREAM_FRAMING = 'binary-v1'
export type DaemonStreamFraming = 'ndjson' | typeof BINARY_STREAM_FRAMING

const EVENT_FRAME = 1
const DATA_FRAME = 2
const FRAME_HEADER_BYTES = 5
const DATA_META_LENGTH_BYTES = 2
const MAX_DATA_META_BYTES = 0xffff
// Share the NDJSON ceiling to keep reader bounds and writer splitting consistent.
export const BINARY_STREAM_MAX_FRAME_BYTES = NDJSON_MAX_LINE_BYTES

export type StreamDataPayloadMeta = {
  seq?: number
  rawLength?: number
  sequenceChars?: number
  transformed?: boolean
}

export function encodeBinaryStreamEventFrame(event: unknown): Buffer {
  return encodeBinaryStreamJsonFrame(JSON.stringify(event))
}

function encodeBinaryStreamJsonFrame(json: string): Buffer {
  const bodyBytes = Buffer.byteLength(json, 'utf8')
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + bodyBytes)
  frame[0] = EVENT_FRAME
  frame.writeUInt32BE(bodyBytes, 1)
  frame.write(json, FRAME_HEADER_BYTES, 'utf8')
  return frame
}

function encodeDataMeta(sessionId: string, payload: StreamDataPayloadMeta): string {
  return JSON.stringify({ type: 'event', event: 'data', sessionId, payload })
}

export function binaryStreamDataFrameOverheadBytes(
  sessionId: string,
  payload: StreamDataPayloadMeta
): number {
  return (
    FRAME_HEADER_BYTES +
    DATA_META_LENGTH_BYTES +
    Buffer.byteLength(encodeDataMeta(sessionId, payload), 'utf8')
  )
}

export function encodeBinaryStreamDataFrame(
  sessionId: string,
  data: string,
  payload?: StreamDataPayloadMeta
): Buffer
export function encodeBinaryStreamDataFrame(
  sessionId: string,
  data: string,
  payload: StreamDataPayloadMeta,
  maxFrameBytes: number
): Buffer | null
export function encodeBinaryStreamDataFrame(
  sessionId: string,
  data: string,
  payload: StreamDataPayloadMeta = {},
  maxFrameBytes = Number.POSITIVE_INFINITY
): Buffer | null {
  // UTF-8 would replace surrogate halves that a producer can release in separate emissions.
  if (!data.isWellFormed()) {
    const json = JSON.stringify({
      type: 'event',
      event: 'data',
      sessionId,
      payload: { ...payload, data }
    })
    return FRAME_HEADER_BYTES + Buffer.byteLength(json, 'utf8') <= maxFrameBytes
      ? encodeBinaryStreamJsonFrame(json)
      : null
  }
  const meta = encodeDataMeta(sessionId, payload)
  const metaBytes = Buffer.byteLength(meta, 'utf8')
  if (metaBytes > MAX_DATA_META_BYTES) {
    throw new RangeError(`Stream data frame metadata exceeds ${MAX_DATA_META_BYTES} bytes`)
  }
  const dataBytes = Buffer.byteLength(data, 'utf8')
  const bodyBytes = DATA_META_LENGTH_BYTES + metaBytes + dataBytes
  if (FRAME_HEADER_BYTES + bodyBytes > maxFrameBytes) {
    return null
  }
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + bodyBytes)
  frame[0] = DATA_FRAME
  frame.writeUInt32BE(bodyBytes, 1)
  frame.writeUInt16BE(metaBytes, FRAME_HEADER_BYTES)
  const metaOffset = FRAME_HEADER_BYTES + DATA_META_LENGTH_BYTES
  frame.write(meta, metaOffset, 'utf8')
  frame.write(data, metaOffset + metaBytes, 'utf8')
  return frame
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeDataFrame(body: Buffer): DaemonEvent | null {
  if (body.length < DATA_META_LENGTH_BYTES) {
    return null
  }
  const metaEnd = DATA_META_LENGTH_BYTES + body.readUInt16BE(0)
  if (metaEnd > body.length) {
    return null
  }
  const meta: unknown = JSON.parse(body.toString('utf8', DATA_META_LENGTH_BYTES, metaEnd))
  if (!isRecord(meta) || meta.event !== 'data' || !isRecord(meta.payload)) {
    return null
  }
  meta.payload.data = body.toString('utf8', metaEnd)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same trust boundary as the NDJSON reader, which casts parsed stream records to DaemonEvent; the data shape is checked above.
  return meta as DaemonEvent
}

export type BinaryStreamFrameReader = {
  feed(chunk: Buffer): void
}

/** Drop malformed records; invalid headers are fatal because their frame boundaries cannot be trusted. */
export function createBinaryStreamFrameReader(
  onEvent: (event: DaemonEvent) => void,
  onFatal: (error: Error) => void,
  maxFrameBytes = BINARY_STREAM_MAX_FRAME_BYTES
): BinaryStreamFrameReader {
  let chunks: Buffer[] = []
  let bufferedBytes = 0
  let failed = false

  const contiguousHead = (bytes: number): Buffer => {
    if (chunks[0].length < bytes) {
      // Concatenating once per socket chunk would be quadratic for large frames.
      chunks = [Buffer.concat(chunks, bufferedBytes)]
    }
    return chunks[0]
  }

  const consume = (head: Buffer, bytes: number): void => {
    if (head.length === bytes) {
      chunks.shift()
    } else {
      chunks[0] = head.subarray(bytes)
    }
    bufferedBytes -= bytes
  }

  const ownPendingHead = (): void => {
    const head = chunks[0]
    // Copy small tails once per feed to release large backing buffers without quadratic frame-by-frame copies.
    if (
      head &&
      head.buffer.byteLength > Buffer.poolSize &&
      head.length * 2 < head.buffer.byteLength
    ) {
      chunks[0] = Buffer.from(head)
    }
  }

  const deliver = (kind: number, body: Buffer): void => {
    let event: unknown
    try {
      event = kind === DATA_FRAME ? decodeDataFrame(body) : JSON.parse(body.toString('utf8'))
    } catch {
      return
    }
    if (isRecord(event) && event.type === 'event') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: matches the NDJSON stream reader's existing record-to-DaemonEvent cast.
      onEvent(event as DaemonEvent)
    }
  }

  return {
    feed(chunk) {
      if (failed || chunk.length === 0) {
        return
      }
      chunks.push(chunk)
      bufferedBytes += chunk.length
      while (bufferedBytes >= FRAME_HEADER_BYTES) {
        const header = contiguousHead(FRAME_HEADER_BYTES)
        const kind = header[0]
        const bodyBytes = header.readUInt32BE(1)
        if ((kind !== EVENT_FRAME && kind !== DATA_FRAME) || bodyBytes > maxFrameBytes) {
          failed = true
          chunks = []
          bufferedBytes = 0
          onFatal(new Error(`Invalid daemon stream frame (kind ${kind}, ${bodyBytes} bytes)`))
          return
        }
        const frameBytes = FRAME_HEADER_BYTES + bodyBytes
        if (bufferedBytes < frameBytes) {
          break
        }
        const head = contiguousHead(frameBytes)
        const body = head.subarray(FRAME_HEADER_BYTES, frameBytes)
        consume(head, frameBytes)
        deliver(kind, body)
      }
      ownPendingHead()
    }
  }
}
