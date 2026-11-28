/** Coalesce spinner repeats to reduce IPC, but heartbeat every 500ms so working titles
 * still cancel Pi/OMP mid-turn hook-done notifications within HOOK_DONE_QUIET_MS (1500ms). */
export const DECORATIVE_TITLE_FACT_HEARTBEAT_MS = 500

export type DecorativeTitleFactEmissionInput = {
  decorativeOnly: boolean
  /** Stale-working clears carry a distinct flag and cannot be coalesced away. */
  staleWorkingTitleClear: boolean
  lastEmittedAtMs: number | null
  nowMs: number
}

export function shouldEmitTitleFactForFrame({
  decorativeOnly,
  staleWorkingTitleClear,
  lastEmittedAtMs,
  nowMs
}: DecorativeTitleFactEmissionInput): boolean {
  if (!decorativeOnly || staleWorkingTitleClear) {
    return true
  }
  if (lastEmittedAtMs === null) {
    return true
  }
  // A backwards clock step must not park the heartbeat until it catches up.
  return nowMs < lastEmittedAtMs || nowMs - lastEmittedAtMs >= DECORATIVE_TITLE_FACT_HEARTBEAT_MS
}
