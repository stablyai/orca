import { MAX_TIMER_DELAY_MS } from '../../shared/timer-delay'

export type RuntimeMobileFilePathInventory = {
  paths: string[]
  totalCount: number
  truncated: boolean
}

type CacheEntry = RuntimeMobileFilePathInventory & { expiresAt: number }

/** TTL/LRU cache for autocomplete inventories. It avoids launching rg for
 *  every mobile keystroke while bounding retained worktrees and paths. */
export class RuntimeMobileFilePathSearchCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<RuntimeMobileFilePathInventory>>()
  private readonly expirationTimers = new Map<
    string,
    { token: symbol; timer: ReturnType<typeof setTimeout> }
  >()

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number
  ) {}

  async get(
    key: string,
    load: () => Promise<RuntimeMobileFilePathInventory>,
    now?: number
  ): Promise<RuntimeMobileFilePathInventory> {
    const requestedAt = now ?? Date.now()
    const cached = this.entries.get(key)
    if (cached && cached.expiresAt > requestedAt) {
      this.entries.delete(key)
      this.entries.set(key, cached)
      return cached
    }
    this.removeEntry(key)
    const pending = this.inFlight.get(key)
    if (pending) {
      return pending
    }
    const next = load()
      .then((loaded) => {
        // Why: a slow SSH scan should receive a full TTL after it becomes usable,
        // not arrive already expired because the clock started before its I/O.
        const expiresAt = (now ?? Date.now()) + this.ttlMs
        this.entries.set(key, { ...loaded, expiresAt })
        // Explicit per-call clocks stay caller-controlled; production uses the wall clock.
        if (now === undefined) {
          this.scheduleExpiry(key, expiresAt)
        }
        while (this.entries.size > this.maxEntries) {
          const oldest = this.entries.keys().next().value
          if (!oldest) {
            break
          }
          this.removeEntry(oldest)
        }
        return loaded
      })
      .finally(() => {
        if (this.inFlight.get(key) === next) {
          this.inFlight.delete(key)
        }
      })
    // Why: debounced clients can overlap on a cold key; sharing this promise
    // prevents duplicate local rg or SSH inventory scans.
    this.inFlight.set(key, next)
    return next
  }

  private removeEntry(key: string): void {
    this.entries.delete(key)
    const expiration = this.expirationTimers.get(key)
    if (expiration) {
      clearTimeout(expiration.timer)
      this.expirationTimers.delete(key)
    }
  }

  private scheduleExpiry(key: string, expiresAt: number): void {
    const previous = this.expirationTimers.get(key)
    if (previous) {
      clearTimeout(previous.timer)
      this.expirationTimers.delete(key)
    }
    if (!Number.isFinite(expiresAt)) {
      return
    }
    const token = Symbol()
    const timer = setTimeout(
      RuntimeMobileFilePathSearchCache.expiryCallback(new WeakRef(this), key, token),
      Math.min(MAX_TIMER_DELAY_MS, Math.max(0, expiresAt - Date.now()))
    )
    timer.unref()
    this.expirationTimers.set(key, { token, timer })
  }

  private static expiryCallback(
    owner: WeakRef<RuntimeMobileFilePathSearchCache>,
    key: string,
    token: symbol
  ): () => void {
    return () => owner.deref()?.expireEntry(key, token)
  }

  private expireEntry(key: string, token: symbol): void {
    if (this.expirationTimers.get(key)?.token !== token) {
      return
    }
    const entry = this.entries.get(key)
    if (!entry || Date.now() >= entry.expiresAt) {
      this.removeEntry(key)
    } else {
      this.scheduleExpiry(key, entry.expiresAt)
    }
  }
}

/** Preserves composer ranking: full-path/basename prefixes first, then substring
 *  matches, while returning only the requested bounded candidate slice. */
export function rankRuntimeMobileFilePaths(
  paths: readonly string[],
  query: string,
  limit: number
): { paths: string[]; totalCount: number } {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return { paths: paths.slice(0, limit), totalCount: paths.length }
  }
  const prefix: string[] = []
  const substring: string[] = []
  let totalCount = 0
  for (const path of paths) {
    const lower = path.toLowerCase()
    const basename = lower.slice(lower.lastIndexOf('/') + 1)
    if (lower.startsWith(normalizedQuery) || basename.startsWith(normalizedQuery)) {
      totalCount++
      if (prefix.length < limit) {
        prefix.push(path)
      }
    } else if (lower.includes(normalizedQuery)) {
      totalCount++
      if (substring.length < limit) {
        substring.push(path)
      }
    }
  }
  return { paths: [...prefix, ...substring].slice(0, limit), totalCount }
}
