// Burst caps for the telemetry transport. Three independent buckets — all
// must be satisfied for an event to transmit or a consent mutation to apply.
//
//   (1) Per-event-name token bucket — defends against runaway-`useEffect`
//       bugs and repeated error serializations. `agent_error` is rate-limited
//       slightly tighter (20/min) than the default (30/min).
//
//   (2) Per-session global ceiling (1,000 events) — defends against a
//       compromised renderer. A renderer rendering attacker-controllable
//       content can invoke `window.api.telemetryTrack` at any rate the
//       per-event-name bucket allows; without a global ceiling, 24h of
//       abuse at the per-event cap could emit ~650K events and blow the
//       PostHog billing cap in one session.
//
//   (3) Consent-mutation bucket (≤5 `setOptIn` calls per session) — a real
//       user flips the Privacy pane toggle a handful of times at most;
//       beyond that it is either a bug or a compromised renderer.
//
// All buckets reset when `resetBurstCapsForSession()` is called at the start
// of a fresh telemetry session (on `initTelemetry`). Within a session, the
// per-event token bucket refills continuously at its `capacity / 60_000` ms
// rate; the global ceiling and the consent-mutation bucket do not refill
// within a session by design — the whole point of the global ceiling is to
// cap aggregate per-session volume.
//
// Overflow is silent past the first crossing: each bucket logs exactly one
// `console.warn` the first time it rejects an attempt in a given session,
// then drops quietly until the next session reset. Rate-limiting the logs
// themselves is what keeps a pathological caller from DoSing stderr.

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

// Module-level state. One Store instance / one telemetry session per main
// process; there is no multi-tenant reuse to worry about. `initTelemetry`
// calls `resetBurstCapsForSession()` to start fresh on each session.
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
  // Continuous refill — `capacity` tokens per `WINDOW_MS` ms. Computed
  // lazily on each access so we do not need a timer; equivalent to the
  // standard token-bucket formula used by most rate limiters.
  const elapsed = now - bucket.lastRefill
  if (elapsed > 0) {
    const refill = (elapsed / WINDOW_MS) * bucket.capacity
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + refill)
    bucket.lastRefill = now
  }
  return bucket
}

/**
 * Consume one token for the given event name. Returns `true` if the event is
 * allowed to proceed, `false` if any of the buckets rejected it.
 *
 * Ordering rationale: per-event bucket first, per-session ceiling second.
 * The per-event bucket is the attention-conserving check (drops runaway
 * useEffects early, before counting against the session ceiling); the global
 * ceiling is the correctness backstop against a compromised renderer that
 * cycles through event names to evade the per-event caps.
 */
export function consumeBurstToken(name: EventName): boolean {
  // Reject unknown event names here so renderer-controlled strings cannot
  // grow `perEventBuckets` past the fixed `eventSchemas` size. The IPC
  // `telemetry:track` handler casts any string to `EventName`, so a
  // compromised renderer could otherwise flood unique bogus names and
  // unboundedly grow the Map before the validator rejects them. Downstream
  // validator still rejects with the proper "unknown event" reason.
  //
  // Use `Object.hasOwn` rather than `in` — the latter walks the prototype
  // chain, so a compromised renderer could pass `'toString'`, `'__proto__'`,
  // `'constructor'`, etc. to bypass the guard and seed buckets for every
  // `Object.prototype` key. Growth would be bounded (~12 keys) but the whole
  // point of this check is to keep the Map size pinned to the compile-time
  // `eventSchemas` surface.
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
 * Consume one token from the consent-mutation bucket. Returns `true` if the
 * caller is allowed to apply a consent mutation, `false` if the per-session
 * ceiling has been reached. Renderer-triggered IPC calls are the only
 * callers of this bucket — main-originated consent mutations bypass IPC and
 * are not rate-limited here.
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

/**
 * Reset every bucket. Called at the start of each telemetry session from
 * `initTelemetry`. Tests also call it to get a clean slate between cases.
 */
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
