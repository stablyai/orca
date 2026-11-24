import type { ProviderRelayRecord } from '../protocol/daemon-provider-relay-protocol'

/** `bytes` is what the record is charged in memory: its UTF-8 size plus a fixed overhead. */
export type HeldRecord = ProviderRelayRecord & { bytes: number }

/** Acked records are skipped by index and compacted in bulk, so per-line acks stay O(1). */
const MEMORY_COMPACT_MIN = 1024

/**
 * The spool's in-memory records in seq order; `head` skips those already released. Running byte
 * totals make the size of any released prefix a binary search.
 */
export class SpoolMemory {
  records: HeldRecord[] = []
  head = 0
  /** totals[i] is the bytes of records[0..i]; released bytes are totals[head - 1]. */
  private totals: number[] = []

  constructor(private readonly capBytes: number) {}

  get bytes(): number {
    return (this.totals.at(-1) ?? 0) - this.released()
  }

  push(record: HeldRecord): void {
    this.records.push(record)
    this.totals.push((this.totals.at(-1) ?? 0) + record.bytes)
  }

  /** Drops records through `seq`; released lines go by count or by size, so a few huge lines can't outlive their ack. */
  releaseThrough(seq: number): void {
    while (this.head < this.records.length && this.records[this.head].seq <= seq) {
      this.head++
    }
    const released = this.released()
    if (
      this.head === this.records.length ||
      released >= this.capBytes / 2 ||
      (this.head >= MEMORY_COMPACT_MIN && this.head * 2 >= this.records.length)
    ) {
      this.records = this.records.slice(this.head)
      this.totals = this.totals.slice(this.head).map((total) => total - released)
      this.head = 0
    }
  }

  /** Held bytes at or below `seq`: what releasing through it would free. */
  bytesThrough(seq: number): number {
    let low = this.head
    let high = this.records.length - 1
    let through = this.released()
    while (low <= high) {
      const mid = (low + high) >> 1
      if (this.records[mid].seq <= seq) {
        through = this.totals[mid]
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    return through - this.released()
  }

  /** Records after `seq`, or null when the file holds some of them (through `fileThrough`). */
  after(seq: number, fileThrough: number): HeldRecord[] | null {
    return fileThrough > seq ? null : this.records.slice(this.head).filter((r) => r.seq > seq)
  }

  /** Empties memory and returns what it held, in seq order. */
  takeAll(): HeldRecord[] {
    const held = this.records.slice(this.head)
    this.records = []
    this.totals = []
    this.head = 0
    return held
  }

  /** Records a failed write didn't land rejoin memory in seq order. */
  merge(records: HeldRecord[]): void {
    this.records = [...records, ...this.records.slice(this.head)].sort(
      (left, right) => left.seq - right.seq
    )
    let total = 0
    this.totals = this.records.map((record) => (total += record.bytes))
    this.head = 0
  }

  private released(): number {
    return this.head > 0 ? this.totals[this.head - 1] : 0
  }
}
