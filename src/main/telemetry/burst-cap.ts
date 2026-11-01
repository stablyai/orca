// Per-event refill caps runaway producers; non-refilling session/consent ceilings bound aggregate volume. Reset per telemetry session and warn once per bucket so overflow cannot flood stderr.

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
  // Refill lazily to avoid another timer.
  const elapsed = now - bucket.lastRefill
  if (elapsed > 0) {
    const refill = (elapsed / WINDOW_MS) * bucket.capacity
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + refill)
    bucket.lastRefill = now
  }
  return bucket
}

/** Spend per-event tokens before session budget so one runaway producer cannot exhaust every event; the global ceiling also bounds cycling names. */
export function consumeBurstToken(name: EventName): boolean {
  // Reject untrusted IPC names before map allocation; own-property checks exclude prototype keys.
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

/** Renderer consent mutations share a session cap; main-originated changes bypass this IPC guard. */
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

export function resetBurstCapsForSession(): void {
  perEventBuckets.clear()
  perSessionCount = 0
  perSessionWarned = false
  consentMutationCount = 0
  consentMutationWarned = false
}

export function _getBurstCapStateForTests(): {
  perEventBuckets: Map<string, TokenBucket>
  perSessionCount: number
  consentMutationCount: number
} {
  return { perEventBuckets, perSessionCount, consentMutationCount }
}
