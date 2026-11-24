// Frames a phone may have in flight before it acks one. Two cover decode and one round trip on a fast link.
const BASE_WINDOW_FRAMES = 2
// A backstop only: the queue-delay test bounds buffering. 16 keeps 10 fps up to a 1.6 s round trip.
const MAX_WINDOW_FRAMES = 16
// Beyond the base window, a frame goes out only while the link has queued less than this.
const QUEUE_DELAY_ALLOWANCE_MS = 100
// The shell drops oversize frames unannounced; probe with one frame, backing off, when acks stop.
const STALL_PROBE_MS = 2_000
const STALL_PROBE_MAX_MS = 8_000

export type BrowserScreencastFrameCredit = {
  canSend: () => boolean
  recordSent: (seq: number) => void
  /** Cumulative: credits every sent frame up to and including `seq`. */
  acknowledge: (seq: number) => void
  dispose: () => void
}

type SentFrame = { seq: number; sentAt: number }

/** Bounds a viewer's unacked frames by queueing delay rather than a fixed count, so a long but
 * idle link keeps its frame rate while a slow one stops filling buffers between host and phone. */
export function createBrowserScreencastFrameCredit(options: {
  /** Credit opened up: send the newest held frame, if any. */
  onCreditAvailable: () => void
}): BrowserScreencastFrameCredit {
  const inFlight: SentFrame[] = []
  // Lowest send-to-ack time seen; never raised, so queueing delay cannot inflate the window.
  let minRttMs: number | null = null
  let probeDelayMs = STALL_PROBE_MS
  let probeTimer: ReturnType<typeof setTimeout> | null = null
  let probeReady = false

  const clearProbe = (): void => {
    if (probeTimer) {
      clearTimeout(probeTimer)
      probeTimer = null
    }
  }

  const armProbe = (): void => {
    if (probeTimer) {
      return
    }
    probeTimer = setTimeout(() => {
      probeTimer = null
      probeReady = true
      probeDelayMs = Math.min(probeDelayMs * 2, STALL_PROBE_MAX_MS)
      options.onCreditAvailable()
    }, probeDelayMs)
  }

  const hasCredit = (): boolean => {
    if (probeReady || inFlight.length < BASE_WINDOW_FRAMES) {
      return true
    }
    if (inFlight.length >= MAX_WINDOW_FRAMES || minRttMs === null) {
      return false
    }
    return Date.now() - inFlight[0]!.sentAt < minRttMs + QUEUE_DELAY_ALLOWANCE_MS
  }

  return {
    canSend() {
      if (hasCredit()) {
        return true
      }
      armProbe()
      return false
    },
    recordSent(seq) {
      probeReady = false
      inFlight.push({ seq, sentAt: Date.now() })
      // A probe past the cap means older frames are presumed lost.
      if (inFlight.length > MAX_WINDOW_FRAMES) {
        inFlight.shift()
      }
    },
    acknowledge(seq) {
      // inFlight is in seq order, so the acked frames are a prefix.
      let count = 0
      while (count < inFlight.length && inFlight[count]!.seq <= seq) {
        count += 1
      }
      if (count === 0) {
        return
      }
      const newest = inFlight[count - 1]!
      if (newest.seq === seq) {
        const rtt = Date.now() - newest.sentAt
        minRttMs = minRttMs === null ? rtt : Math.min(minRttMs, rtt)
      }
      inFlight.splice(0, count)
      clearProbe()
      probeDelayMs = STALL_PROBE_MS
      options.onCreditAvailable()
    },
    dispose: clearProbe
  }
}

type CreditedSubscription = {
  pairedDeviceId: string | undefined
  credit: BrowserScreencastFrameCredit
}

// Keyed by subscription id: the relay keeps it intact, and it is unguessable per viewer.
const creditedSubscriptions = new Map<string, CreditedSubscription>()

export function registerBrowserScreencastFrameCredit(
  subscriptionId: string,
  pairedDeviceId: string | undefined,
  credit: BrowserScreencastFrameCredit
): () => void {
  const entry = { pairedDeviceId, credit }
  creditedSubscriptions.set(subscriptionId, entry)
  return () => {
    if (creditedSubscriptions.get(subscriptionId) === entry) {
      creditedSubscriptions.delete(subscriptionId)
    }
    credit.dispose()
  }
}

/** False when the subscription ended or belongs to another device; late acks are normal. */
export function acknowledgeBrowserScreencastFrame(
  subscriptionId: string,
  pairedDeviceId: string | undefined,
  seq: number
): boolean {
  const entry = creditedSubscriptions.get(subscriptionId)
  if (!entry || entry.pairedDeviceId !== pairedDeviceId) {
    return false
  }
  entry.credit.acknowledge(seq)
  return true
}
