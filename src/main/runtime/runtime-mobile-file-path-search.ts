export type RuntimeMobileFilePathInventory = {
  paths: string[]
  totalCount: number
  truncated: boolean
}

type CacheEntry = RuntimeMobileFilePathInventory & { expiresAt: number }

/** Lazy TTL/LRU cache for autocomplete inventories. It avoids launching rg for
 *  every mobile keystroke while bounding retained worktrees and paths. */
export class RuntimeMobileFilePathSearchCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<RuntimeMobileFilePathInventory>>()

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
    this.entries.delete(key)
    const pending = this.inFlight.get(key)
    if (pending) {
      return pending
    }
    const next = load()
      .then((loaded) => {
        // Why: a slow SSH scan should receive a full TTL after it becomes usable,
        // not arrive already expired because the clock started before its I/O.
        this.entries.set(key, { ...loaded, expiresAt: (now ?? Date.now()) + this.ttlMs })
        while (this.entries.size > this.maxEntries) {
          const oldest = this.entries.keys().next().value as string | undefined
          if (!oldest) {
            break
          }
          this.entries.delete(oldest)
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
    const basename = lower.split('/').pop() ?? lower
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
