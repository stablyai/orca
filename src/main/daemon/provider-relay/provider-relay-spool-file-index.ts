/** Acked entries are skipped by index and compacted in bulk, so per-line acks stay O(1). */
const COMPACT_MIN_ENTRIES = 1024

/**
 * What the spool file holds, as packed [seq, running byte total] pairs, so back-pressure counts only
 * unacked bytes and the bytes through any seq are found by binary search.
 */
export class SpoolFileIndex {
  private entries: number[] = []
  private head = 0
  /** Running total of every entry added, and of those acked; their difference is unacked. */
  private total = 0
  private ackedTotal = 0
  /** Highest seq written to the file; 0 when there is no file. */
  lastSeq = 0
  /** The client's ack as last applied; a replay treats rows at or below it as accounted for. */
  ackedThrough = 0

  get unackedBytes(): number {
    return this.total - this.ackedTotal
  }

  add(seq: number, bytes: number): void {
    this.total += bytes
    this.entries.push(seq, this.total)
    this.lastSeq = seq
  }

  ackThrough(seq: number): void {
    this.ackedThrough = Math.max(this.ackedThrough, seq)
    while (this.head < this.entries.length && this.entries[this.head] <= seq) {
      this.ackedTotal = this.entries[this.head + 1]
      this.head += 2
    }
    if (this.head >= 2 * COMPACT_MIN_ENTRIES && this.head * 2 >= this.entries.length) {
      this.entries = this.entries.slice(this.head)
      this.head = 0
    }
  }

  /** Records a failed write never landed; only those still unacked are debited, as acks debited the rest. */
  drop(seqs: Set<number>): void {
    const kept: number[] = []
    let previous = this.ackedTotal
    let total = this.ackedTotal
    for (let at = this.head; at < this.entries.length; at += 2) {
      const bytes = this.entries[at + 1] - previous
      previous = this.entries[at + 1]
      if (!seqs.has(this.entries[at])) {
        total += bytes
        kept.push(this.entries[at], total)
      }
    }
    this.entries = kept
    this.head = 0
    this.total = total
    // With nothing unacked left in the file, a replay has nothing to read from it.
    this.lastSeq = kept.at(-2) ?? 0
  }

  /** Whether the file must hold this record whole; entries are in seq order, so this is a binary search. */
  has(seq: number): boolean {
    let low = this.head / 2
    let high = this.entries.length / 2 - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      const at = this.entries[mid * 2]
      if (at === seq) {
        return true
      }
      if (at < seq) {
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    return false
  }

  /** Unacked bytes at or below `seq`: what an ack through it would free. */
  bytesThrough(seq: number): number {
    let low = this.head / 2
    let high = this.entries.length / 2 - 1
    let through = this.ackedTotal
    while (low <= high) {
      const mid = (low + high) >> 1
      if (this.entries[mid * 2] <= seq) {
        through = this.entries[mid * 2 + 1]
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    return through - this.ackedTotal
  }

  /** How many records after `seq` the file must still hold whole. */
  countAfter(seq: number): number {
    let count = 0
    for (let at = this.head; at < this.entries.length; at += 2) {
      if (this.entries[at] > seq) {
        count++
      }
    }
    return count
  }

  clear(): void {
    this.entries = []
    this.head = 0
    this.total = 0
    this.ackedTotal = 0
    this.lastSeq = 0
  }
}
