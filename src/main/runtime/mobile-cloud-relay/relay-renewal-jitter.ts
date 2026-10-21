// Why: a cell recreate reconnects a whole cohort inside one second. Every host
// in it then took its lease from the same second and, with only a 60s-wide
// spread, renewed inside the same second ~54 minutes later — a self-sustaining
// fleet-wide reconnect burst. Full +/-10% jitter spreads that cohort over
// minutes instead.
export const RELAY_RENEWAL_JITTER_RATIO = 0.1

// The latest jittered renewal still lands this far before expiry.
export const RELAY_RENEWAL_SAFETY_MARGIN_MS = 90_000

// Why: the relay accepts a rebind at any point in the lease and resets the full
// TTL from it (cloud/apps/relay/src/host-session-registry.ts:736-743), so
// renewing early is free; only renewing late is fatal (:997 drains an expired
// lease). That asymmetry is why the base is shrunk to fit the upward jitter
// rather than the jittered value being clipped at the margin.
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
