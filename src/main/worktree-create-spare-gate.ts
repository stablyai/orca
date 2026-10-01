// When a spare checkout may start (rule 2: never build one while the machine is busy). Numbers come
// from the #23699 perf study: at idle a plain checkout of the 31k-file fixture took 2.1-8.3 s, every
// one under outside load took 17-62 s, and the next create after a slow one was slow up to 105 s
// later and never after.
import { isLocalWorktreeCreateInFlight } from './git/local-worktree-create-activity'

/** A plain add this long is slow on any repo; a repo whose idle spare builds take longer raises it. */
export const SLOW_CHECKOUT_FLOOR_MS = 15_000
export const SLOW_CREATE_COOLDOWN_MS = 3 * 60_000
/** About twice the p90 spare build (13.3 s), so base flips waste at most one build per two. */
export const SPARE_ABANDON_WINDOW_MS = 30_000

/**
 * A repo's baseline is the fastest of its last few completed spare builds. Spares are built only on
 * an idle machine, so a build is the repo's own idle checkout time; creates never feed it, so a
 * fast failure, a hit's handover or a slow create cannot move it. The minimum ignores a build that
 * an outside load slowed.
 */
const BASELINE_BUILDS = 5
// In memory only.
const spareBuildsByRepo = new Map<string, number[]>()
let createsStarted = 0
const lastBaseChangeAbandonByRepo = new Map<string, number>()
let cooldownUntil = 0

/** The plain-add duration at which this repo's disk counts as busy. */
export function slowPlainAddThresholdMs(repoKey: string): number {
  const builds = spareBuildsByRepo.get(repoKey) ?? []
  return Math.max(SLOW_CHECKOUT_FLOOR_MS, builds.length > 0 ? 2 * Math.min(...builds) : 0)
}

/** Counts every local create start, so a spare request can tell one happened since it arrived. */
export function noteLocalCreateStarted(): void {
  createsStarted += 1
}

export function localCreatesStarted(): number {
  return createsStarted
}

/**
 * A create's plain `git worktree add` (never a spare hit or a no-checkout add), whether it
 * succeeded or failed. A slow one starts the cooldown from the moment it ended.
 */
export function recordPlainAddDuration(
  repoKey: string,
  durationMs: number,
  now = Date.now()
): void {
  if (durationMs >= slowPlainAddThresholdMs(repoKey)) {
    cooldownUntil = Math.max(cooldownUntil, now + SLOW_CREATE_COOLDOWN_MS)
  }
}

/** A spare build that completed unaborted. */
export function recordSpareBuildDuration(repoKey: string, durationMs: number): void {
  const builds = spareBuildsByRepo.get(repoKey) ?? []
  spareBuildsByRepo.set(repoKey, [...builds, durationMs].slice(-BASELINE_BUILDS))
}

export type SpareStartRefusal = 'create_in_flight' | 'slow_create_cooldown'

export function spareStartRefusal(now = Date.now()): SpareStartRefusal | null {
  if (isLocalWorktreeCreateInFlight()) {
    return 'create_in_flight'
  }
  return now < cooldownUntil ? 'slow_create_cooldown' : null
}

/** A request for another base may replace the repo's spare once per window. */
export function mayAbandonSpareForBaseChange(repoKey: string, now = Date.now()): boolean {
  const last = lastBaseChangeAbandonByRepo.get(repoKey)
  return last === undefined || now - last >= SPARE_ABANDON_WINDOW_MS
}

export function recordSpareAbandonedForBaseChange(repoKey: string, now = Date.now()): void {
  lastBaseChangeAbandonByRepo.set(repoKey, now)
}

export function _resetSpareGateForTests(): void {
  spareBuildsByRepo.clear()
  lastBaseChangeAbandonByRepo.clear()
  cooldownUntil = 0
}
