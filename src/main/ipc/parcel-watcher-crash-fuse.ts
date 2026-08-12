const CRASH_WINDOW_MS = 2 * 60_000
const MAX_CRASHES_PER_WINDOW = 3

export class WatcherProcessCrashFuse {
  private crashTimes: number[] = []
  private open = false

  recordCrash(now = Date.now()): void {
    if (this.open) {
      return
    }
    this.removeExpired(now)
    this.crashTimes.push(now)
    this.open = this.crashTimes.length >= MAX_CRASHES_PER_WINDOW
  }

  isOpen(now = Date.now()): boolean {
    if (this.open) {
      return true
    }
    this.removeExpired(now)
    return false
  }

  reset(): void {
    this.crashTimes = []
    this.open = false
  }

  private removeExpired(now: number): void {
    this.crashTimes = this.crashTimes.filter((time) => now - time < CRASH_WINDOW_MS)
  }
}
