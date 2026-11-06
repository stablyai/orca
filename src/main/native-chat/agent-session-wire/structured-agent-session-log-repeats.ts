// Suppress recurring failures so rotated traces retain surrounding history.

export const STRUCTURED_AGENT_SESSION_LOG_REPEAT_WINDOW_MS = 5 * 60_000
const MAX_TRACKED_REPEATS = 256

type TrackedRepeat = { writtenAt: number; suppressed: number }

export type StructuredAgentSessionLogRepeats = {
  /** null suppresses; otherwise return suppressed count since the previous write. */
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
  // Map insertion order tracks last-write age for eviction.
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
