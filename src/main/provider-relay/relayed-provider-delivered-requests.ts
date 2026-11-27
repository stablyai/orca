/** Requests already handed on, by seq, so a replay or reattach never asks the user twice. */
export class RelayedProviderDeliveredRequests {
  private readonly seqs = new Set<number>()

  has(seq: number): boolean {
    return this.seqs.has(seq)
  }

  add(seq: number): void {
    this.seqs.add(seq)
  }

  delete(seq: number): void {
    this.seqs.delete(seq)
  }

  get size(): number {
    return this.seqs.size
  }

  /**
   * After an attach from `fromSeq`: a request at or before it comes again only while the daemon
   * still holds it unanswered (`pending`), so the rest are forgotten and the set stays as small as
   * what is open.
   */
  forgetSettled(fromSeq: number, pending: readonly number[]): void {
    const open = new Set(pending)
    for (const seq of this.seqs) {
      if (seq <= fromSeq && !open.has(seq)) {
        this.seqs.delete(seq)
      }
    }
  }
}
