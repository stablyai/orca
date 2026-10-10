/**
 * Length-prefixed stream framing that carries PTY data as raw UTF-8 bytes instead of a JSON
 * string, so neither side escapes or parses the payload. A stream socket uses it only after its
 * hello negotiated it; every other socket, and every daemon that predates it, stays on NDJSON.
 *
 * Frame: [kind u8][body length u32 BE][body]
 * - EVENT: body is the UTF-8 JSON of a stream event.
 * - DATA:  body is [meta length u16 BE][meta JSON][data bytes]; meta is the data event with
 *          `payload.data` removed, which the reader restores from the bytes.
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
// Same ceiling the NDJSON reader enforces, so splitting policy and receiver memory bounds match.
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

/** Frame bytes excluding the data itself; the writer budgets splits with it. */
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

/**
 * A malformed record is dropped like an unparsable NDJSON line, but a bad header means the
 * length prefix can no longer be trusted, so the reader stops and reports a fatal error.
 */
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
      // Why one concat per frame: joining on every socket chunk is quadratic for multi-MB frames.
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
          return
        }
        const head = contiguousHead(frameBytes)
        const body = head.subarray(FRAME_HEADER_BYTES, frameBytes)
        consume(head, frameBytes)
        deliver(kind, body)
      }
    }
  }
}
