import type { PostHog } from 'posthog-node'
import type { Store } from '../persistence'
import { resolveConsent } from './consent'
import { POSTHOG_FLUSH_AT, POSTHOG_FLUSH_INTERVAL_MS } from './posthog-transport'

type CaptureMessage = Parameters<PostHog['capture']>[0]
/** Desktop passes a first-window scheduler; Electron stays out of this plain-Node module. */
export type StartScheduler = (start: () => void) => void

let writeKey: string | null = null
let storeRef: Store | null = null
let firstFlushTimer: ReturnType<typeof setTimeout> | null = null
const heldCaptures: CaptureMessage[] = []

/** Hold captures until the scheduled start so the SDK stays off the startup path (#35752). */
export function deferStart(
  key: string,
  store: Store,
  schedule: StartScheduler,
  start: () => void
): void {
  writeKey = key
  storeRef = store
  schedule(start)
}

export function isStartDeferred(): boolean {
  return writeKey !== null
}

/** Keep capture time for replay; send no later than an eager client would (flushAt or flushInterval). */
export function holdCapture(message: CaptureMessage, start: () => PostHog | null): void {
  heldCaptures.push({ ...message, timestamp: new Date() })
  if (heldCaptures.length >= POSTHOG_FLUSH_AT) {
    // Replaying a full batch trips the SDK's own flushAt send.
    start()
    return
  }
  if (firstFlushTimer) {
    return
  }
  firstFlushTimer = setTimeout(() => {
    firstFlushTimer = null
    start()
      ?.flush()
      .catch((err: unknown) => console.warn('[telemetry] first flush failed:', err))
  }, POSTHOG_FLUSH_INTERVAL_MS)
  firstFlushTimer.unref?.()
}

function consentAllows(): boolean {
  return storeRef !== null && resolveConsent(storeRef.getSettings()).effective === 'enabled'
}

/** Quit loads the SDK only for held events that consent still allows. */
export function hasSendableHeldCaptures(): boolean {
  return heldCaptures.length > 0 && consentAllows()
}

function retireFirstFlushDeadline(): void {
  if (firstFlushTimer) {
    clearTimeout(firstFlushTimer)
    firstFlushTimer = null
  }
}

/** Replay in order; the deadline stands in for the timer an eager client armed at the first held event. */
export function replayHeld(client: PostHog, held: CaptureMessage[]): void {
  // Before its first flush the SDK queue holds every enqueue, so the flushAt-th enqueue is the only SDK flush
  // attempt that can precede the deadline; retire it then, whether that send succeeds or fails.
  let enqueued = 0
  const stopListening = client.on('capture', (payload: unknown) => {
    // Opted-out captures report a string instead of enqueuing.
    if (payload !== null && typeof payload === 'object' && ++enqueued >= POSTHOG_FLUSH_AT) {
      stopListening()
      retireFirstFlushDeadline()
    }
  })
  for (const message of held) {
    client.capture(message)
  }
}

/** Claim the deferred start once; held events are dropped if consent was withdrawn since capture. */
export function takeStart(): { writeKey: string; held: CaptureMessage[] } | null {
  if (writeKey === null) {
    return null
  }
  const held = heldCaptures.splice(0)
  // The first-flush deadline survives so replayed events keep it.
  const start = { writeKey, held: consentAllows() ? held : [] }
  writeKey = null
  return start
}

export function resetStart(): void {
  writeKey = null
  storeRef = null
  heldCaptures.length = 0
  retireFirstFlushDeadline()
}
