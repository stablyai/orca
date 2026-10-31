// Cell recreates synchronize lease cohorts; ±10% jitter prevents recurring fleet-wide renewal bursts.
export const RELAY_RENEWAL_JITTER_RATIO = 0.1

export const RELAY_RENEWAL_SAFETY_MARGIN_MS = 90_000

// Early rebind resets the full TTL; late renewal expires the lease. Shrink the base to fit upward jitter without clipping.
export function relayRenewalDelayMs(expiresAt: number, now: number, random: () => number): number {
  const remaining = expiresAt - now
  const latest = remaining - RELAY_RENEWAL_SAFETY_MARGIN_MS
  if (latest <= 0) {
    return 0
  }
  const base = latest / (1 + RELAY_RENEWAL_JITTER_RATIO)
  const jittered = base * (1 + (random() * 2 - 1) * RELAY_RENEWAL_JITTER_RATIO)
  return Math.max(0, Math.min(Math.floor(jittered), latest))
}
