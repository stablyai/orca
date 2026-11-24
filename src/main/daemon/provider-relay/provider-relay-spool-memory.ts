import type { ProviderRelayRecord } from '../protocol/daemon-provider-relay-protocol'

/** `bytes` is what the record is charged in memory: its UTF-8 size plus a fixed overhead. */
export type HeldRecord = ProviderRelayRecord & { bytes: number }

/** Acked records are skipped by index and compacted in bulk, so per-line acks stay O(1). */
const MEMORY_COMPACT_MIN = 1024

/** The spool's in-memory records in seq order; `head` skips those already released. */
export class SpoolMemory {
  records: HeldRecord[] = []
  head = 0
  bytes = 0
  private releasedBytes = 0

  constructor(private readonly capBytes: number) {}

  push(record: HeldRecord): void {
    this.records.push(record)
    this.bytes += record.bytes
  }

  /** Drops records through `seq`; released lines go by count or by size, so a few huge lines can't outlive their ack. */
  releaseThrough(seq: number): void {
    while (this.head < this.records.length && this.records[this.head].seq <= seq) {
      const { bytes } = this.records[this.head]
      this.bytes -= bytes
      this.releasedBytes += bytes
      this.head++
    }
    if (
      this.head === this.records.length ||
      this.releasedBytes >= this.capBytes / 2 ||
      (this.head >= MEMORY_COMPACT_MIN && this.head * 2 >= this.records.length)
    ) {
      this.releasedBytes = 0
      this.records = this.records.slice(this.head)
      this.head = 0
    }
  }

  /** Empties memory and returns what it held, in seq order. */
  takeAll(): HeldRecord[] {
    const held = this.records.slice(this.head)
    this.records = []
    this.head = 0
    this.releasedBytes = 0
    this.bytes = 0
    return held
  }

  /** Records a failed write didn't land rejoin memory in seq order. */
  merge(records: HeldRecord[]): void {
    for (const record of records) {
      this.bytes += record.bytes
    }
    this.records = [...records, ...this.records.slice(this.head)].sort(
      (left, right) => left.seq - right.seq
    )
    this.head = 0
  }
}
