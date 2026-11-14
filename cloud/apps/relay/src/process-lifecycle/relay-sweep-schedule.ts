// Same-rollout directors otherwise contend on inventory locks together; longer idempotent sweep periods spread arrivals without increasing load.
export const SWEEP_JITTER_FRACTION = 0.2

export function jitteredSweepIntervalMs(
  baseMs: number,
  random: () => number = Math.random
): number {
  // Only ever longer: a shorter period would raise the very load being spread.
  return baseMs + Math.floor(random() * baseMs * SWEEP_JITTER_FRACTION)
}
