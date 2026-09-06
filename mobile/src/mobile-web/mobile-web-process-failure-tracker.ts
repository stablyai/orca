const PROCESS_FAILURE_WINDOW_MS = 60_000
const PROCESS_FAILURE_ROLLBACK_THRESHOLD = 3

export class MobileWebProcessFailureTracker {
  private readonly failuresByBuild = new Map<string, number[]>()

  record(buildId: string, now = Date.now()): boolean {
    const cutoff = now - PROCESS_FAILURE_WINDOW_MS
    const recent = (this.failuresByBuild.get(buildId) ?? []).filter(
      (timestamp) => timestamp >= cutoff
    )
    recent.push(now)
    this.failuresByBuild.set(buildId, recent)
    return recent.length >= PROCESS_FAILURE_ROLLBACK_THRESHOLD
  }

  reset(): void {
    this.failuresByBuild.clear()
  }
}
