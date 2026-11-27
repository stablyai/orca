import type { HeldRecord } from './provider-relay-spool-memory'

const KEPT_TAIL_CAP_BYTES = 1024 * 1024

/**
 * Lines kept to the spool file while a client is attached (an open item's floor) that it hasn't
 * acked: a detach reads what they open from here instead of the file. Without them it can't
 * say what is open, and the agent is never idle-stopped.
 */
export class SpoolKeptTail {
  private records: HeldRecord[] = []
  private bytes = 0
  /** The last file record not held here; while the client hasn't acked it, this can't stand in. */
  private untailedThrough = 0

  constructor(private readonly capBytes = KEPT_TAIL_CAP_BYTES) {}

  wrote(record: HeldRecord, kept: boolean): void {
    if (!kept) {
      this.untailedThrough = Math.max(this.untailedThrough, record.seq)
      return
    }
    this.records.push(record)
    this.bytes += record.bytes
    let drop = 0
    while (this.bytes > this.capBytes && drop < this.records.length) {
      this.bytes -= this.records[drop]!.bytes
      this.untailedThrough = Math.max(this.untailedThrough, this.records[drop]!.seq)
      drop++
    }
    if (drop > 0) {
      this.records.splice(0, drop)
    }
  }

  ackThrough(seq: number): void {
    const keep = this.records.findIndex((record) => record.seq > seq)
    const drop = keep === -1 ? this.records.length : keep
    for (const record of this.records.slice(0, drop)) {
      this.bytes -= record.bytes
    }
    this.records.splice(0, drop)
  }

  /** These and `inMemory` after `seq`, in seq order; null when the file holds some that aren't here. */
  after(seq: number, inMemory: readonly HeldRecord[]): HeldRecord[] | null {
    if (this.untailedThrough > seq) {
      return null
    }
    const kept = this.records.filter((record) => record.seq > seq)
    return kept.length === 0 ? [...inMemory] : [...kept, ...inMemory].sort((a, b) => a.seq - b.seq)
  }
}
