const WATCHER_FAILURE_REFRESH_COOLDOWN_MS = 60_000

export class WorktreeWatcherFailureRefreshCooldown {
  private refreshedAt: number | null = null
  private deferred: ReturnType<typeof setTimeout> | null = null

  consume(now = Date.now()): boolean {
    if (this.refreshedAt !== null && now - this.refreshedAt < WATCHER_FAILURE_REFRESH_COOLDOWN_MS) {
      return false
    }
    this.refreshedAt = now
    return true
  }

  /** A cooled-down failure still owes its refresh; pace it to the cooldown's end instead of dropping it. */
  defer(refresh: () => void, now = Date.now()): void {
    if (this.deferred) {
      return
    }
    const dueInMs = Math.max(
      0,
      (this.refreshedAt ?? now) + WATCHER_FAILURE_REFRESH_COOLDOWN_MS - now
    )
    this.deferred = setTimeout(() => {
      this.deferred = null
      this.refreshedAt = Date.now()
      refresh()
    }, dueInMs)
    this.deferred.unref?.()
  }

  dispose(): void {
    clearTimeout(this.deferred ?? undefined)
    this.deferred = null
  }
}
