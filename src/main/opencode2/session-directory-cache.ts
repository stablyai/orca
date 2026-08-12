// Why: sessionID → directory resolution state for the opencode2 watcher,
// including failed-lookup backoff. Kept out of hook-service.ts to stay under
// the max-lines limit and to unit-test the eviction policy in isolation.

const MAX_ENTRIES = 512
const FAILED_RETRY_MS = 60_000

export class OpenCode2SessionDirectoryCache {
  private readonly directories = new Map<string, string>()
  private readonly failedAt = new Map<string, number>()

  get(sessionId: string): string | null {
    return this.directories.get(sessionId) ?? null
  }

  remember(sessionId: string, directory: string): void {
    this.failedAt.delete(sessionId)
    this.setBounded(this.directories, sessionId, directory)
  }

  rememberFailure(sessionId: string): void {
    this.setBounded(this.failedAt, sessionId, Date.now())
  }

  shouldFetch(sessionId: string): boolean {
    if (this.directories.has(sessionId)) {
      return false
    }
    const lastAttempt = this.failedAt.get(sessionId)
    return lastAttempt === undefined || Date.now() - lastAttempt >= FAILED_RETRY_MS
  }

  private setBounded(map: Map<string, string | number>, key: string, value: string | number): void {
    if (map.size >= MAX_ENTRIES && !map.has(key)) {
      const oldest = map.keys().next().value
      if (typeof oldest === 'string') {
        map.delete(oldest)
      }
    }
    map.set(key, value)
  }
}
