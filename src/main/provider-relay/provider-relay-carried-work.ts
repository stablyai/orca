import type { ProviderRelayWorkMarker } from '../daemon/protocol/daemon-provider-relay-protocol'
import {
  ProviderRelayOpenWork,
  ProviderRelayWorkReader
} from '../daemon/provider-relay/provider-relay-work-markers'
import type { ProviderRelayAckFloor } from './relayed-provider-output'

type OpenWork = Record<string, string[][]>

/**
 * Background work the daemon saw start while no app was attached. A reattached session never saw
 * it start, so its own open set misses it: this keeps it until an agent line ends it, and adds it
 * to the session's open set at the next detach. Lines are read only while something is carried.
 */
export class ProviderRelayCarriedWork {
  private work: ProviderRelayOpenWork | null = null
  private readonly reader: ProviderRelayWorkReader

  constructor(markers: readonly ProviderRelayWorkMarker[]) {
    this.reader = new ProviderRelayWorkReader(markers)
  }

  take(open: OpenWork | undefined): void {
    this.work =
      open && Object.values(open).some((keys) => keys.length > 0)
        ? new ProviderRelayOpenWork(open)
        : null
  }

  observe(line: string): void {
    if (!this.work) {
      return
    }
    for (const change of this.reader.read(line)) {
      // A start belongs to the session's own view; only what ends the carried work matters here.
      if (change.effect !== 'start') {
        this.work.apply(change)
      }
    }
    if (!this.work.busy) {
      this.work = null
    }
  }

  /** The session's open set plus what is still carried; null (can't say) stays null. */
  merge(open: OpenWork | null): OpenWork | null {
    if (!open || !this.work) {
      return open
    }
    const merged: OpenWork = { ...open }
    for (const [group, keys] of Object.entries(this.work.keys())) {
      merged[group] = [...(merged[group] ?? []), ...keys]
    }
    return merged
  }

  /** Feeds every line to the carried work as well as to the provider's own ack floor. */
  withFloor(floor: ProviderRelayAckFloor | undefined): ProviderRelayAckFloor {
    return {
      observe: (seq, line) => {
        floor?.observe(seq, line)
        this.observe(line)
      },
      floor: () => floor?.floor() ?? null
    }
  }
}
