import type { PendingOutputRecord } from '../../protocol/daemon-rpc-contract'

const JOURNAL_BATCH_BYTES = 64 * 1024
const JOURNAL_COALESCE_CODE_UNITS = 64 * 1024

export type TerminalJournalBatch = {
  data: PendingOutputRecord[]
  /** Head records fully covered by this batch. */
  records: number
  /** Code units of the next head record already covered; a large callback streams in slices. */
  headOffset: number
}

/**
 * Applied records not yet committed, in order. Charges follow each delivered callback's full
 * backing until it commits, even while a large one streams out in slices.
 */
export class TerminalJournalBacklog {
  private readonly queue: PendingOutputRecord[] = []
  private readonly charges: number[] = []
  // Head records an append or fold already encoded; coalescing into them would lose bytes.
  private sealed = 0
  private headOffset = 0
  private chargedBytes = 0
  /** Monotonic record counts; a flush waits for committed to reach an earlier intake. */
  intake = 0
  committed = 0

  get bytes(): number {
    return this.chargedBytes
  }

  get length(): number {
    return this.queue.length
  }

  /** Returns the bytes charged for this record. */
  push(record: PendingOutputRecord): number {
    const bytes = record.kind === 'output' ? Buffer.byteLength(record.data, 'utf8') + 5 : 9
    const last = this.queue.at(-1)
    if (
      record.kind === 'output' &&
      last?.kind === 'output' &&
      this.queue.length > this.sealed &&
      last.data.length < JOURNAL_COALESCE_CODE_UNITS
    ) {
      last.data += record.data
      this.charges[this.charges.length - 1] += bytes
    } else {
      this.queue.push(record.kind === 'output' ? { kind: 'output', data: record.data } : record)
      this.charges.push(bytes)
      this.intake += 1
    }
    this.chargedBytes += bytes
    return bytes
  }

  take(): TerminalJournalBatch {
    const batch = takeTerminalJournalBatch(this.queue, this.headOffset)
    this.sealed = Math.max(this.sealed, batch.records)
    return batch
  }

  /** Seals every queued record for a fold; returns how many it covers. */
  sealAll(): number {
    this.sealed = this.queue.length
    return this.sealed
  }

  /** The uncommitted records as an immutable cut; a streamed head starts at its offset. */
  snapshot(): PendingOutputRecord[] {
    const records = this.queue.slice()
    const head = records[0]
    if (this.headOffset > 0 && head?.kind === 'output') {
      records[0] = { kind: 'output', data: head.data.slice(this.headOffset) }
    }
    return records
  }

  /** Returns the bytes released by committing these head records. */
  commit(records: number, headOffset: number): number {
    const released = this.charges.splice(0, records).reduce((sum, bytes) => sum + bytes, 0)
    this.queue.splice(0, records)
    this.headOffset = headOffset
    this.sealed = Math.max(0, this.sealed - records)
    this.committed += records
    this.chargedBytes -= released
    return released
  }

  /** Drops everything for a gap; returns the bytes released. */
  clear(): number {
    const released = this.chargedBytes
    this.queue.length = 0
    this.charges.length = 0
    this.sealed = 0
    this.headOffset = 0
    this.chargedBytes = 0
    return released
  }
}

/** At most 64 KiB of encoded frames, sliced surrogate-safe from the queue head. */
function takeTerminalJournalBatch(
  queue: readonly PendingOutputRecord[],
  headOffset: number
): TerminalJournalBatch {
  const data: PendingOutputRecord[] = []
  let bytes = 9
  let records = 0
  for (const [index, record] of queue.entries()) {
    if (record.kind !== 'output') {
      if (data.length > 0 && bytes + 9 > JOURNAL_BATCH_BYTES) {
        break
      }
      data.push(record)
      bytes += 9
      records += 1
      continue
    }
    const start = index === 0 ? headOffset : 0
    const room = JOURNAL_BATCH_BYTES - bytes - 5
    let end = Math.min(record.data.length, start + room)
    let piece = record.data.slice(start, end)
    let pieceBytes = Buffer.byteLength(piece, 'utf8')
    // Shrink by the observed bytes per unit until the slice fits the remaining room.
    while (pieceBytes > room && end > start) {
      end = start + Math.floor(((end - start) * room) / pieceBytes)
      piece = record.data.slice(start, end)
      pieceBytes = Buffer.byteLength(piece, 'utf8')
    }
    if (
      end < record.data.length &&
      end > start &&
      isHighSurrogate(record.data.charCodeAt(end - 1))
    ) {
      end -= 1
      piece = record.data.slice(start, end)
      pieceBytes = Buffer.byteLength(piece, 'utf8')
    }
    if (end <= start) {
      break
    }
    data.push({
      kind: 'output',
      data: start === 0 && end === record.data.length ? record.data : piece
    })
    bytes += pieceBytes + 5
    if (end < record.data.length) {
      return { data, records, headOffset: end }
    }
    records += 1
  }
  return { data, records, headOffset: 0 }
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff
}
