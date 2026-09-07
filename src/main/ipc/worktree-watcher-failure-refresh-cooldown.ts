const WATCHER_FAILURE_REFRESH_COOLDOWN_MS = 60_000

export class WorktreeWatcherFailureRefreshCooldown {
  private refreshedAt: number | null = null

  consume(now = Date.now()): boolean {
    if (this.refreshedAt !== null && now - this.refreshedAt < WATCHER_FAILURE_REFRESH_COOLDOWN_MS) {
      return false
    }
    this.refreshedAt = now
    return true
  }

  reset(): void {
    this.refreshedAt = null
  }
}
