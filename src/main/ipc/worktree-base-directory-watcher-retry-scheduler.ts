type RetryEntry = {
  version: string
  attempts: number
  timer: NodeJS.Timeout | null
  action: () => void
}

const RETRY_DELAYS_MS = [250, 1_000, 4_000] as const

export class WorktreeBaseDirectoryWatcherRetryScheduler {
  private readonly entries = new Map<string, RetryEntry>()
  private disposed = false

  schedule(key: string, version: string, action: () => void): boolean {
    if (this.disposed) {
      return false
    }
    const previous = this.entries.get(key)
    if (previous?.version === version && previous.timer) {
      previous.action = action
      return true
    }
    if (previous?.version !== version) {
      clearTimeout(previous?.timer ?? undefined)
      this.entries.delete(key)
    }
    const attempts = previous?.version === version ? previous.attempts : 0
    if (attempts >= RETRY_DELAYS_MS.length) {
      return false
    }

    const entry: RetryEntry = {
      version,
      attempts: attempts + 1,
      timer: null,
      action
    }
    entry.timer = setTimeout(() => {
      if (this.disposed || this.entries.get(key) !== entry) {
        return
      }
      entry.timer = null
      entry.action()
    }, RETRY_DELAYS_MS[attempts])
    this.entries.set(key, entry)
    return true
  }

  clear(key: string): void {
    const entry = this.entries.get(key)
    clearTimeout(entry?.timer ?? undefined)
    this.entries.delete(key)
  }

  retainKeys(keys: ReadonlySet<string>): void {
    for (const key of this.entries.keys()) {
      if (!keys.has(key)) {
        this.clear(key)
      }
    }
  }

  activate(): void {
    this.disposed = false
  }

  dispose(): void {
    this.disposed = true
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer ?? undefined)
    }
    this.entries.clear()
  }
}
