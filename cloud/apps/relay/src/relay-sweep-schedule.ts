// Why: every director instance boots from the same rollout, so its periodic
// sweeps land on the same wall-clock second across instances and pile onto the
// one global cell-inventory lock together. A per-process offset spreads the
// arrivals; the sweeps are idempotent, so a slightly longer period is free.
export const SWEEP_JITTER_FRACTION = 0.2

export function jitteredSweepIntervalMs(
  baseMs: number,
  random: () => number = Math.random
): number {
  // Only ever longer: a shorter period would raise the very load being spread.
  return baseMs + Math.floor(random() * baseMs * SWEEP_JITTER_FRACTION)
}
