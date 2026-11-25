import type { ProviderRelayAttachResult } from '../protocol/daemon-provider-relay-protocol'

export type ProviderRelayAckOptions = { cut?: boolean; held?: boolean; cutKeys?: string[] }

/** Kept lines the client gave up through its own acks, and the items it said the cut split. */
export class ProviderRelayCut {
  private through = 0
  private keys: string[] | null = null

  record(seq: number, keepFrom: number | undefined, { cut, cutKeys }: ProviderRelayAckOptions) {
    if (cut) {
      // Kept from `keepFrom` on, the cut is before it: a replay from there starts inside the item.
      this.through = Math.max(this.through, keepFrom === undefined ? seq : keepFrom - 1)
      this.keys = cutKeys ?? null
    }
  }

  /** What an attach from `cursor` reports; the spool's own drops count as a cut no key names. */
  report(
    spoolTruncated: number,
    cursor: number
  ): Pick<ProviderRelayAttachResult, 'truncatedThrough' | 'cutKeys'> {
    const truncatedThrough = Math.max(spoolTruncated, this.through)
    // Lines the client already had before its cursor were never missing from its replay.
    // A cut at the cursor counts too: the kept lines it gave up were the ones a replay needed.
    if (truncatedThrough <= 0 || truncatedThrough < cursor) {
      return {}
    }
    return this.keys && this.through >= spoolTruncated
      ? { truncatedThrough, cutKeys: this.keys }
      : { truncatedThrough }
  }
}
