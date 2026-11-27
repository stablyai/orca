import type { ProviderRelayAttachResult } from '../protocol/daemon-provider-relay-protocol'

export type ProviderRelayAckOptions = {
  cut?: boolean
  held?: boolean
  cutKeys?: string[]
  savedThrough?: number
}

/** Kept lines the client gave up through its own acks, and the items it said the cut split. */
export class ProviderRelayCut {
  private through = 0
  private keys: string[] | null = null
  /** Every line through here is in the client's journal, as it said. */
  private saved = 0

  record(
    seq: number,
    keepFrom: number | undefined,
    { cut, cutKeys, savedThrough }: ProviderRelayAckOptions
  ) {
    this.saved = Math.max(this.saved, Math.min(seq, savedThrough ?? 0))
    if (cut) {
      // Kept from `keepFrom` on, the cut is before it: a replay from there starts inside the item.
      this.through = Math.max(this.through, keepFrom === undefined ? seq : keepFrom - 1)
    }
    if (cut || cutKeys) {
      this.keys = cutKeys ?? null
    }
  }

  /**
   * What an attach reports; the spool's own drops count as a cut no key names. A cut before the
   * cursor counts too: an item it split may still be open, and its start never replays again.
   */
  report(
    spoolTruncated: number
  ): Pick<ProviderRelayAttachResult, 'truncatedThrough' | 'cutKeys' | 'savedThrough'> {
    const truncatedThrough = Math.max(spoolTruncated, this.through)
    // The spool's own drop past them splits items no key names.
    const keys = this.through >= spoolTruncated ? this.keys : null
    return {
      ...(truncatedThrough > 0 ? { truncatedThrough } : {}),
      ...(keys ? { cutKeys: keys, savedThrough: this.saved } : {})
    }
  }
}
