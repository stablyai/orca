import type { PendingOutputRecord } from './types'

// On-disk framing for the incremental terminal history log (output.log).
//
// Layout: header, then batch frames appended every checkpoint tick.
//   header  = magic 'OCKL' (4 bytes) + u8 formatVersion + u32le generation
//   frame   = u8 kind + u32le payloadLength + payload
//     kind 0x01 batch  — payload u32le seq (one per appended take batch)
//     kind 0x02 output — payload utf8 bytes
//     kind 0x03 resize — payload u16le cols + u16le rows
//     kind 0x04 clear  — empty payload
//
// Why framing instead of raw bytes: a crash can tear the final append. Length
// prefixes make the torn tail detectable so restore truncates at the last
// complete frame instead of replaying half an escape sequence ("reading a
// corrupt checkpoint is worse than reading a slightly stale one").

const LOG_MAGIC = 'OCKL'
const LOG_FORMAT_VERSION = 1
export const LOG_HEADER_BYTES = 9

const FRAME_BATCH = 0x01
const FRAME_OUTPUT = 0x02
const FRAME_RESIZE = 0x03
const FRAME_CLEAR = 0x04
const FRAME_HEADER_BYTES = 5
const BATCH_FRAME_BYTES = FRAME_HEADER_BYTES + 4

export type TerminalHistoryLogBatch = {
  seq: number
  records: PendingOutputRecord[]
}

export type TerminalHistoryLogContents = {
  generation: number
  batches: TerminalHistoryLogBatch[]
  /** True when the file ended mid-frame (torn final append). The complete
   *  prefix is still safe to replay. */
  truncatedTail: boolean
}

export function encodeLogHeader(generation: number): Buffer {
  const header = Buffer.alloc(LOG_HEADER_BYTES)
  header.write(LOG_MAGIC, 0, 'ascii')
  header.writeUInt8(LOG_FORMAT_VERSION, 4)
  header.writeUInt32LE(generation >>> 0, 5)
  return header
}

/** Validates magic + format version and returns the generation, or null when
 *  the buffer is not a readable log header. */
export function decodeLogHeader(buffer: Buffer): number | null {
  if (buffer.length < LOG_HEADER_BYTES) {
    return null
  }
  if (buffer.toString('ascii', 0, 4) !== LOG_MAGIC) {
    return null
  }
  if (buffer.readUInt8(4) !== LOG_FORMAT_VERSION) {
    return null
  }
  return buffer.readUInt32LE(5)
}

export function encodeLogBatch(seq: number, records: PendingOutputRecord[]): Buffer {
  const byteLength = measureLogBatchBytes(records)
  return encodeLogBatchWithByteLength(seq, records, byteLength)
}

export function encodeLogBatchWithinLimit(
  seq: number,
  records: PendingOutputRecord[],
  maxBytes: number
): Buffer | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    return null
  }
  const byteLength = measureLogBatchBytes(records, maxBytes)
  return byteLength === null ? null : encodeLogBatchWithByteLength(seq, records, byteLength)
}

function measureLogBatchBytes(records: PendingOutputRecord[]): number
function measureLogBatchBytes(records: PendingOutputRecord[], maxBytes: number): number | null
function measureLogBatchBytes(records: PendingOutputRecord[], maxBytes?: number): number | null {
  let byteLength = BATCH_FRAME_BYTES
  if (maxBytes !== undefined && byteLength > maxBytes) {
    return null
  }
  for (const record of records) {
    if (record.kind === 'output') {
      const payloadBytes = Buffer.byteLength(record.data, 'utf8')
      if (maxBytes !== undefined && payloadBytes > maxBytes - byteLength - FRAME_HEADER_BYTES) {
        return null
      }
      byteLength += FRAME_HEADER_BYTES + payloadBytes
    } else if (record.kind === 'resize') {
      byteLength += FRAME_HEADER_BYTES + 4
    } else {
      byteLength += FRAME_HEADER_BYTES
    }
    if (maxBytes !== undefined && byteLength > maxBytes) {
      return null
    }
  }
  return byteLength
}

function encodeLogBatchWithByteLength(
  seq: number,
  records: PendingOutputRecord[],
  byteLength: number
): Buffer {
  const batch = Buffer.allocUnsafe(byteLength)
  let offset = 0
  offset = writeFrameHeader(batch, offset, FRAME_BATCH, 4)
  batch.writeUInt32LE(seq >>> 0, offset)
  offset += 4

  for (const record of records) {
    if (record.kind === 'output') {
      const payloadBytes = Buffer.byteLength(record.data, 'utf8')
      offset = writeFrameHeader(batch, offset, FRAME_OUTPUT, payloadBytes)
      batch.write(record.data, offset, payloadBytes, 'utf8')
      offset += payloadBytes
    } else if (record.kind === 'resize') {
      offset = writeFrameHeader(batch, offset, FRAME_RESIZE, 4)
      batch.writeUInt16LE(clampU16(record.cols), offset)
      batch.writeUInt16LE(clampU16(record.rows), offset + 2)
      offset += 4
    } else {
      offset = writeFrameHeader(batch, offset, FRAME_CLEAR, 0)
    }
  }
  return batch
}

/** Returns null for missing magic / unknown format version — callers fall
 *  back to checkpoint-only restore. Seq-gap detection is also done here: a
 *  non-contiguous batch sequence means an appended batch was lost (e.g. main
 *  crashed between take and append), so the byte stream has a hole and
 *  replaying it would corrupt the restored terminal. */
export function decodeTerminalHistoryLog(buffer: Buffer): TerminalHistoryLogContents | null {
  const generation = decodeLogHeader(buffer)
  if (generation === null) {
    return null
  }

  const batches: TerminalHistoryLogBatch[] = []
  let current: TerminalHistoryLogBatch | null = null
  let offset = LOG_HEADER_BYTES
  let truncatedTail = false

  while (offset < buffer.length) {
    if (offset + 5 > buffer.length) {
      truncatedTail = true
      break
    }
    const kind = buffer.readUInt8(offset)
    const payloadLength = buffer.readUInt32LE(offset + 1)
    const payloadStart = offset + 5
    const payloadEnd = payloadStart + payloadLength
    if (payloadEnd > buffer.length) {
      truncatedTail = true
      break
    }

    if (kind === FRAME_BATCH) {
      if (payloadLength !== 4) {
        return null
      }
      const seq = buffer.readUInt32LE(payloadStart)
      if (current && seq !== current.seq + 1) {
        return null
      }
      current = { seq, records: [] }
      batches.push(current)
    } else if (!current) {
      // A record frame before any batch frame means the writer and format
      // disagree — treat the whole log as unreadable.
      return null
    } else if (kind === FRAME_OUTPUT) {
      current.records.push({
        kind: 'output',
        data: buffer.toString('utf8', payloadStart, payloadEnd)
      })
    } else if (kind === FRAME_RESIZE) {
      if (payloadLength !== 4) {
        return null
      }
      current.records.push({
        kind: 'resize',
        cols: buffer.readUInt16LE(payloadStart),
        rows: buffer.readUInt16LE(payloadStart + 2)
      })
    } else if (kind === FRAME_CLEAR) {
      current.records.push({ kind: 'clear' })
    } else {
      return null
    }

    offset = payloadEnd
  }

  return { generation, batches, truncatedTail }
}

function writeFrameHeader(
  buffer: Buffer,
  offset: number,
  kind: number,
  payloadBytes: number
): number {
  buffer.writeUInt8(kind, offset)
  buffer.writeUInt32LE(payloadBytes, offset + 1)
  return offset + FRAME_HEADER_BYTES
}

function clampU16(value: number): number {
  return Math.max(0, Math.min(0xffff, Math.floor(value)))
}
