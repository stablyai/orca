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
  const frames: Buffer[] = [encodeFrame(FRAME_BATCH, encodeSeqPayload(seq))]
  for (const record of records) {
    if (record.kind === 'output') {
      frames.push(encodeFrame(FRAME_OUTPUT, Buffer.from(record.data, 'utf8')))
    } else if (record.kind === 'resize') {
      const payload = Buffer.alloc(4)
      payload.writeUInt16LE(clampU16(record.cols), 0)
      payload.writeUInt16LE(clampU16(record.rows), 2)
      frames.push(encodeFrame(FRAME_RESIZE, payload))
    } else {
      frames.push(encodeFrame(FRAME_CLEAR, Buffer.alloc(0)))
    }
  }
  return Buffer.concat(frames)
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

function encodeFrame(kind: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt8(kind, 0)
  header.writeUInt32LE(payload.length, 1)
  return Buffer.concat([header, payload])
}

function encodeSeqPayload(seq: number): Buffer {
  const payload = Buffer.alloc(4)
  payload.writeUInt32LE(seq >>> 0, 0)
  return payload
}

function clampU16(value: number): number {
  return Math.max(0, Math.min(0xffff, Math.floor(value)))
}
