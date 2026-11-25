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

  /**
   * What an attach reports; the spool's own drops count as a cut no key names. A cut before the
   * cursor counts too: an item it split may still be open, and its start never replays again.
   */
  report(spoolTruncated: number): Pick<ProviderRelayAttachResult, 'truncatedThrough' | 'cutKeys'> {
    const truncatedThrough = Math.max(spoolTruncated, this.through)
    if (truncatedThrough <= 0) {
      return {}
    }
    return this.keys && this.through >= spoolTruncated
      ? { truncatedThrough, cutKeys: this.keys }
      : { truncatedThrough }
  }
}
