import type { StructuredAgentHostClock } from '../../../src/shared/agent-session/structured-agent-session-reducer'

// Ignore delivery jitter below the precision of displayed clocks.
const OFFSET_GRAIN_MS = 1_000

/** Phone clock minus host clock; each host sample covers restarts and corrections, rounded so jitter keeps memoized rows. */
export function mobileStructuredHostClockOffsetMs(
  hostClock: StructuredAgentHostClock | null | undefined
): number {
  return hostClock
    ? Math.round((hostClock.receivedAt - hostClock.hostNow) / OFFSET_GRAIN_MS) * OFFSET_GRAIN_MS
    : 0
}
