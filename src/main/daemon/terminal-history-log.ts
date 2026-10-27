import type { PendingOutputRecord } from './types'

// Length-prefixed frames let recovery stop at a torn append while retaining complete records.

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
  /** A torn final frame leaves the complete prefix safe to replay. */
  truncatedTail: boolean
}

export function encodeLogHeader(generation: number): Buffer {
  const header = Buffer.alloc(LOG_HEADER_BYTES)
  header.write(LOG_MAGIC, 0, 'ascii')
  header.writeUInt8(LOG_FORMAT_VERSION, 4)
  header.writeUInt32LE(generation >>> 0, 5)
  return header
}

/** Return the generation, or null for an incomplete or unsupported header. */
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
  let byteLength = 9
  const outputPayloads: Buffer[] = []
  for (const record of records) {
    if (record.kind === 'output') {
      const payload = Buffer.from(record.data, 'utf8')
      outputPayloads.push(payload)
      byteLength += 5 + payload.length
    } else {
      byteLength += record.kind === 'resize' ? 9 : 5
    }
  }
  const batch = Buffer.allocUnsafe(byteLength)
  batch.writeUInt8(FRAME_BATCH, 0)
  batch.writeUInt32LE(4, 1)
  batch.writeUInt32LE(seq >>> 0, 5)
  let offset = 9
  let outputIndex = 0
  for (const record of records) {
    if (record.kind === 'output') {
      batch.writeUInt8(FRAME_OUTPUT, offset)
      const payload = outputPayloads[outputIndex++]
      batch.writeUInt32LE(payload.length, offset + 1)
      payload.copy(batch, offset + 5)
      offset += 5 + payload.length
    } else if (record.kind === 'resize') {
      batch.writeUInt8(FRAME_RESIZE, offset)
      batch.writeUInt32LE(4, offset + 1)
      batch.writeUInt16LE(clampU16(record.cols), offset + 5)
      batch.writeUInt16LE(clampU16(record.rows), offset + 7)
      offset += 9
    } else {
      batch.writeUInt8(FRAME_CLEAR, offset)
      batch.writeUInt32LE(0, offset + 1)
      offset += 5
    }
  }
  return batch
}

/** Reject malformed logs and sequence gaps; replaying across missing bytes would corrupt recovery. */
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
      // Records without a preceding batch cannot be attributed safely.
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
      if (payloadLength !== 0) {
        return null
      }
      current.records.push({ kind: 'clear' })
    } else {
      return null
    }

    offset = payloadEnd
  }

  return { generation, batches, truncatedTail }
}

function clampU16(value: number): number {
  return Math.max(0, Math.min(0xffff, Math.floor(value)))
}
