// Adaptive, jittered refresh scheduling for per-repo worktree-list scans.
//
// The runtime used to re-scan every repo's `git worktree list` on a flat 30s
// TTL, firing the whole fleet at once — the recurring 8-spawn burst behind the
// steady-state freezes and ~50% CPU spikes (#7576). This schedules each repo
// independently instead: a repo holding the active worktree (or a live pane)
// refreshes at a short floor; an idle repo backs off exponentially to a capped
// interval; and every interval carries ±25% jitter so no two repos come due
// together. Pure, with injectable clock/rng, so the curve is unit-testable.

export const HOT_REFRESH_FLOOR_MS = 60_000
// 1h cap; ±25% jitter spreads cold repos across ~45–75 min so their refreshes
// never align into a burst.
export const COLD_REFRESH_CAP_MS = 60 * 60_000
export const REFRESH_JITTER_RATIO = 0.25

// Floor for the jittered result so a downward jitter swing can't schedule a
// near-immediate re-run.
const MIN_SCHEDULED_INTERVAL_MS = HOT_REFRESH_FLOOR_MS / 2

type RepoScanState = {
  intervalMs: number
  dueAt: number
}

export type WorktreeScanScheduleDeps = {
  now: () => number
  random: () => number
}

export class WorktreeScanSchedule {
  private readonly state = new Map<string, RepoScanState>()

  constructor(private readonly deps: WorktreeScanScheduleDeps) {}

  /** A repo with no scheduled state, or one past its due time, should refresh. */
  isDue(repoId: string): boolean {
    const entry = this.state.get(repoId)
    return entry === undefined || this.deps.now() >= entry.dueAt
  }

  /**
   * Record that a scan just completed and compute the next due time. `isHot`
   * (repo owns the active worktree or a live pane) resets the backoff to the
   * floor; otherwise the interval doubles up to the cap. Returns the next dueAt.
   */
  recordRefresh(repoId: string, isHot: boolean): number {
    const previous = this.state.get(repoId)
    const baseIntervalMs = isHot
      ? HOT_REFRESH_FLOOR_MS
      : Math.min((previous?.intervalMs ?? HOT_REFRESH_FLOOR_MS) * 2, COLD_REFRESH_CAP_MS)
    const dueAt = this.deps.now() + this.jitter(baseIntervalMs)
    this.state.set(repoId, { intervalMs: baseIntervalMs, dueAt })
    return dueAt
  }

  forget(repoId: string): void {
    this.state.delete(repoId)
  }

  clear(): void {
    this.state.clear()
  }

  private jitter(intervalMs: number): number {
    const delta = intervalMs * REFRESH_JITTER_RATIO * (this.deps.random() * 2 - 1)
    return Math.max(MIN_SCHEDULED_INTERVAL_MS, Math.round(intervalMs + delta))
  }
}
