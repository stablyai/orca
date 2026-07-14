const CRASH_WINDOW_MS = 30_000
const MAX_CRASHES_PER_WINDOW = 3

export class WatcherProcessCrashFuse {
  private crashTimes: number[] = []

  recordCrash(now = Date.now()): void {
    this.removeExpired(now)
    this.crashTimes.push(now)
  }

  isOpen(now = Date.now()): boolean {
    this.removeExpired(now)
    return this.crashTimes.length >= MAX_CRASHES_PER_WINDOW
  }

  reset(): void {
    this.crashTimes = []
  }

  private removeExpired(now: number): void {
    this.crashTimes = this.crashTimes.filter((time) => now - time < CRASH_WINDOW_MS)
  }
}
