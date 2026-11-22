import type { SubscriberDeliveryRetention } from './agent-session-subscriber-delivery-lane'

type RetentionSource = { retention(counted: Set<object>): SubscriberDeliveryRetention[] }

export type SubscriberRetentionSummary = {
  /** Subscribers with delivery work running or waiting. */
  busy: number
  pending: number
  oldestMs: number
  liveTextBytes: number
}

const sources = new Set<WeakRef<RetentionSource>>()

export function trackSubscriberRetention(source: RetentionSource): void {
  sources.add(new WeakRef(source))
}

/** Read on the diagnostics sampler's cadence, never per publication. */
export function readSubscriberRetention(): SubscriberRetentionSummary {
  const summary: SubscriberRetentionSummary = { busy: 0, pending: 0, oldestMs: 0, liveTextBytes: 0 }
  const counted = new Set<object>()
  for (const ref of sources) {
    const source = ref.deref()
    if (!source) {
      sources.delete(ref)
      continue
    }
    for (const lane of source.retention(counted)) {
      summary.busy += 1
      summary.pending += lane.pending
      summary.oldestMs = Math.max(summary.oldestMs, lane.oldestMs)
      summary.liveTextBytes += lane.liveTextBytes
    }
  }
  return summary
}
