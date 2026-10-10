// Keeps one failure that recurs on a timer (lease renewal, idle sweep) or on every publication
// (status feed) from flooding the shared, rotated trace file and erasing the history around it.

/** How long a repeated entry stays quiet after it is written. */
export const STRUCTURED_AGENT_SESSION_LOG_REPEAT_WINDOW_MS = 5 * 60_000
const MAX_TRACKED_REPEATS = 256

type TrackedRepeat = { writtenAt: number; suppressed: number }

export type StructuredAgentSessionLogRepeats = {
  /** `null` swallows this entry; a number writes it, carrying the repeats swallowed since the last. */
  admit: (key: string) => number | null
}

export function createStructuredAgentSessionLogRepeats(options?: {
  now?: () => number
  windowMs?: number
  maxTracked?: number
}): StructuredAgentSessionLogRepeats {
  const now = options?.now ?? Date.now
  const windowMs = options?.windowMs ?? STRUCTURED_AGENT_SESSION_LOG_REPEAT_WINDOW_MS
  const maxTracked = options?.maxTracked ?? MAX_TRACKED_REPEATS
  // Insertion order is write order, so the first key is the one written longest ago.
  const tracked = new Map<string, TrackedRepeat>()

  const makeRoom = (at: number): void => {
    for (const [key, repeat] of tracked) {
      if (at - repeat.writtenAt >= windowMs) {
        tracked.delete(key)
      }
    }
    const oldest = tracked.keys().next()
    if (tracked.size >= maxTracked && !oldest.done) {
      tracked.delete(oldest.value)
    }
  }

  return {
    admit: (key) => {
      const at = now()
      const repeat = tracked.get(key)
      if (repeat && at - repeat.writtenAt < windowMs) {
        repeat.suppressed += 1
        return null
      }
      tracked.delete(key)
      if (tracked.size >= maxTracked) {
        makeRoom(at)
      }
      tracked.set(key, { writtenAt: at, suppressed: 0 })
      return repeat?.suppressed ?? 0
    }
  }
}
