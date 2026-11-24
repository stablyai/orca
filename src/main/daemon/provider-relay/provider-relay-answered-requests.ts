import type { ProviderRelayRecord } from '../protocol/daemon-provider-relay-protocol'

/**
 * Spooled agent→client requests that were answered (or resolved or replaced) before the spool was
 * acked past them. A replay hands each on as its cursor only, so a reattached chat never asks for
 * an approval the user already gave.
 */
export class ProviderRelayAnsweredRequests {
  private readonly seqs = new Set<number>()

  constructor(private readonly ackedSeq: () => number) {}

  readonly add = (seq: number): void => {
    // Acked lines are never replayed again, so they are dropped as new answers come in.
    const acked = this.ackedSeq()
    for (const answered of this.seqs) {
      if (answered <= acked) {
        this.seqs.delete(answered)
      }
    }
    if (seq > acked) {
      this.seqs.add(seq)
    }
  }

  /** The record to replay: an answered request goes as its cursor alone. */
  replayed(record: ProviderRelayRecord): ProviderRelayRecord {
    return this.seqs.size > 0 && this.seqs.has(record.seq) ? { seq: record.seq, line: '' } : record
  }
}
