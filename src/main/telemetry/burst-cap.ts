// Three independent burst caps; all must pass to transmit an event or apply a consent mutation:
//   (1) Per-event token bucket (30/min, agent_error 20/min) — caps runaway useEffects/error spam.
//   (2) Per-session ceiling (1,000) — backstops a compromised renderer to protect the PostHog billing cap.
//   (3) Consent-mutation bucket (≤5/session, shared setOptIn+acknowledgeBanner) — more is a bug or attack.
// resetBurstCapsForSession() (on initTelemetry) clears all. Per-event refills continuously; the ceiling
// and consent bucket intentionally don't — the point is to cap aggregate per-session volume.
// Overflow logs once per bucket per session then drops silently, so a pathological caller can't DoS stderr.

import { eventSchemas, type EventName } from '../../shared/telemetry-events'

const PER_EVENT_DEFAULT_CAPACITY = 30
const PER_EVENT_AGENT_ERROR_CAPACITY = 20
const WINDOW_MS = 60_000

const PER_SESSION_CEILING = 1_000
const CONSENT_MUTATION_CEILING = 5

type TokenBucket = {
  tokens: number
  capacity: number
  lastRefill: number
  warned: boolean
}

// Module-level singleton state — one telemetry session per main process, no multi-tenant reuse.
const perEventBuckets = new Map<string, TokenBucket>()
let perSessionCount = 0
let perSessionWarned = false
let consentMutationCount = 0
let consentMutationWarned = false

function capacityFor(name: string): number {
  return name === 'agent_error' ? PER_EVENT_AGENT_ERROR_CAPACITY : PER_EVENT_DEFAULT_CAPACITY
}

function getOrCreateBucket(name: string, now: number): TokenBucket {
  let bucket = perEventBuckets.get(name)
  if (!bucket) {
    const capacity = capacityFor(name)
    bucket = { tokens: capacity, capacity, lastRefill: now, warned: false }
    perEventBuckets.set(name, bucket)
    return bucket
  }
  // Lazy refill on access (avoids a timer): `capacity` tokens per `WINDOW_MS`.
  const elapsed = now - bucket.lastRefill
  if (elapsed > 0) {
    const refill = (elapsed / WINDOW_MS) * bucket.capacity
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + refill)
    bucket.lastRefill = now
  }
  return bucket
}

/**
 * Consume one token for `name`; `true` if allowed, `false` if any bucket rejected it.
 * Order matters: the per-event bucket drops runaway useEffects before they count against the
 * per-session ceiling, which backstops a renderer cycling names to evade the per-event caps.
 */
export function consumeBurstToken(name: EventName): boolean {
  // Bound `perEventBuckets`: the IPC handler casts any string to EventName, so reject unknown
  // names a compromised renderer could flood. `Object.hasOwn` (not `in`) skips prototype-chain keys.
  if (!Object.hasOwn(eventSchemas, name)) {
    return false
  }
  const now = Date.now()
  const bucket = getOrCreateBucket(name, now)
  if (bucket.tokens < 1) {
    if (!bucket.warned) {
      bucket.warned = true
      console.warn(`[telemetry] per-event burst cap hit for '${name}'; dropping further events`)
    }
    return false
  }
  if (perSessionCount >= PER_SESSION_CEILING) {
    if (!perSessionWarned) {
      perSessionWarned = true
      console.warn(
        `[telemetry] per-session event ceiling (${PER_SESSION_CEILING}) hit; dropping further events`
      )
    }
    return false
  }
  bucket.tokens -= 1
  perSessionCount += 1
  return true
}

/**
 * Consume one consent-mutation token; returns `false` once the per-session ceiling is hit.
 * Only renderer IPC calls reach here — main-originated mutations bypass IPC and stay uncapped.
 */
export function consumeConsentMutationToken(): boolean {
  if (consentMutationCount >= CONSENT_MUTATION_CEILING) {
    if (!consentMutationWarned) {
      consentMutationWarned = true
      console.warn(
        `[telemetry] consent-mutation rate limit (${CONSENT_MUTATION_CEILING}/session) hit; dropping further mutations`
      )
    }
    return false
  }
  consentMutationCount += 1
  return true
}

/** Reset every bucket; called on each telemetry session start (`initTelemetry`), and by tests. */
export function resetBurstCapsForSession(): void {
  perEventBuckets.clear()
  perSessionCount = 0
  perSessionWarned = false
  consentMutationCount = 0
  consentMutationWarned = false
}

/** Test-only introspection. Not part of the runtime API. */
export function _getBurstCapStateForTests(): {
  perEventBuckets: Map<string, TokenBucket>
  perSessionCount: number
  consentMutationCount: number
} {
  return { perEventBuckets, perSessionCount, consentMutationCount }
}
