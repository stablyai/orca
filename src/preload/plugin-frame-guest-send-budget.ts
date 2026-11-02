/**
 * Isolated-world budget for what a guest may send to the host. Why written out: the sandboxed
 * preload can't import shared chunks; plugin-frame-guest.test.ts pins these numbers to the host's
 * lanes. Sizes are measured like the host measures them (UTF-8 strings, buffer bytes), so a
 * message this admits is one the host can admit too.
 */
export const PRELOAD_PLUGIN_FRAME_LANES = {
  /** Every ordinary message: the host's shared panel message cap. */
  shared: { maxBytes: 64 * 1024 + 1024 },
  /** `files.saveAs` carries a whole file (64 MiB plus envelope). */
  saveAs: { method: 'files.saveAs', maxBytes: 64 * 1024 * 1024 + 4096 },
  /** `editor.applyEdit` carries a whole document (64 MiB plus envelope). */
  edit: { method: 'editor.applyEdit', maxBytes: 64 * 1024 * 1024 + 4096 },
  /** A components panel's tree and persisted state: the host's render lane and its walk caps. */
  render: {
    events: ['ui.render', 'ui.persist', 'ui.retain'],
    maxBytes: 640 * 1024,
    maxNodes: 5000 * 8 + 1024,
    maxDepth: 64 * 2 + 24
  }
}

export const PRELOAD_PLUGIN_FRAME_RATE = {
  maxMessages: 600,
  maxBytes: 160 * 1024 * 1024,
  perMs: 10_000
}

const DEFAULT_WALK = { maxNodes: 10_000, maxDepth: 100 }
const textEncoder = new TextEncoder()

/** UTF-8 bytes of strings plus buffer bytes; stops (returning more than `stopAfter`) once over. */
export function measurePluginFrameMessageBytes(
  message: unknown,
  stopAfter: number,
  walk: { maxNodes: number; maxDepth: number } = DEFAULT_WALK
): number {
  let total = 0
  let nodes = 0
  const stack: { value: unknown; depth: number }[] = [{ value: message, depth: 0 }]
  for (let item = stack.pop(); item && total <= stopAfter; item = stack.pop()) {
    const { value, depth } = item
    if (++nodes > walk.maxNodes || depth > walk.maxDepth) {
      return stopAfter + 1
    }
    if (typeof value === 'string') {
      // A string longer than the cap in code units is over it in UTF-8 bytes too.
      total += value.length > stopAfter ? stopAfter + 1 : textEncoder.encode(value).byteLength
    } else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      total += value.byteLength
    } else if (Array.isArray(value)) {
      total += 8
      for (const entry of value) {
        stack.push({ value: entry, depth: depth + 1 })
      }
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, entry] of Object.entries(value)) {
        total += key.length
        stack.push({ value: entry, depth: depth + 1 })
      }
    } else {
      total += 8
    }
  }
  return total
}

function laneCap(message: unknown): { maxBytes: number; walk?: typeof DEFAULT_WALK } {
  const method =
    typeof message === 'object' && message !== null && 'method' in message ? message.method : null
  const event =
    typeof message === 'object' && message !== null && 'event' in message ? message.event : null
  const { saveAs, edit, shared, render } = PRELOAD_PLUGIN_FRAME_LANES
  if (typeof event === 'string' && render.events.includes(event)) {
    return { maxBytes: render.maxBytes, walk: render }
  }
  return {
    maxBytes:
      method === saveAs.method
        ? saveAs.maxBytes
        : method === edit.method
          ? edit.maxBytes
          : shared.maxBytes
  }
}

export type PluginFrameSendRefusal =
  | { code: 'too_large' }
  | { code: 'rate_limited'; retryAfterMs: number }

/** Returns null to send, or why not; held in the isolated world so page script cannot reset it. */
export function createPluginFrameSendBudget(
  now: () => number = () => Date.now(),
  rate = PRELOAD_PLUGIN_FRAME_RATE
): (message: unknown) => PluginFrameSendRefusal | null {
  const sent: { at: number; bytes: number }[] = []
  let windowBytes = 0
  return (message) => {
    const at = now()
    for (let oldest = sent[0]; oldest && oldest.at <= at - rate.perMs; oldest = sent[0]) {
      sent.shift()
      windowBytes -= oldest.bytes
    }
    const lane = laneCap(message)
    const bytes = measurePluginFrameMessageBytes(message, lane.maxBytes, lane.walk)
    if (bytes > lane.maxBytes) {
      return { code: 'too_large' }
    }
    if (sent.length >= rate.maxMessages || windowBytes + bytes > rate.maxBytes) {
      return {
        code: 'rate_limited',
        retryAfterMs: Math.max(0, (sent[0]?.at ?? at) + rate.perMs - at)
      }
    }
    sent.push({ at, bytes })
    windowBytes += bytes
    return null
  }
}

/**
 * Real input only: every trusted pointerdown or keydown is one gesture with its own serial. The host
 * admits a user-gesture method once per serial, so one click is one dialog, not five seconds of them.
 */
export function createPluginFrameGestureTracker(now: () => number = () => Date.now()) {
  let serial = 0
  let at = Number.NEGATIVE_INFINITY
  return {
    note(event: { isTrusted: boolean }): void {
      if (event.isTrusted) {
        serial += 1
        at = now()
      }
    },
    /** The latest gesture while it still counts as transient activation (5 s), else 0. */
    current(activationActive: boolean): number {
      return activationActive && now() - at < GESTURE_LIFETIME_MS ? serial : 0
    }
  }
}

const GESTURE_LIFETIME_MS = 5_000
