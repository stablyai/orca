const HERMES_RUN_COUNT_CACHE_TTL_MS = 2000
const HERMES_RUN_COUNT_CACHE_MAX_ENTRIES = 200

type HermesRunCountCacheEntry = {
  promise: Promise<number>
  expiresAt: number
}

const hermesRunCountCache = new Map<string, HermesRunCountCacheEntry>()

export function clearHermesCronOutputRunCountCache(jobId?: string): void {
  if (jobId) {
    hermesRunCountCache.delete(jobId)
    return
  }
  hermesRunCountCache.clear()
}

function pruneHermesRunCountCache(now: number): void {
  for (const [jobId, entry] of hermesRunCountCache) {
    if (entry.expiresAt <= now) {
      hermesRunCountCache.delete(jobId)
    }
  }
  while (hermesRunCountCache.size >= HERMES_RUN_COUNT_CACHE_MAX_ENTRIES) {
    const oldestJobId = hermesRunCountCache.keys().next().value
    if (oldestJobId === undefined) {
      return
    }
    hermesRunCountCache.delete(oldestJobId)
  }
}

export async function readCachedHermesRunCount(
  jobId: string,
  loadRunCount: (jobId: string) => Promise<number>
): Promise<number> {
  const now = Date.now()
  const cached = hermesRunCountCache.get(jobId)
  if (cached && cached.expiresAt > now) {
    return cached.promise
  }
  if (cached) {
    hermesRunCountCache.delete(jobId)
  }
  // Why: external Hermes jobs can be created/removed outside Orca; without a
  // size bound and expired sweep, a long session can pin stale job ids forever.
  pruneHermesRunCountCache(now)
  const entry: HermesRunCountCacheEntry = {
    promise: loadRunCount(jobId),
    expiresAt: Number.POSITIVE_INFINITY
  }
  hermesRunCountCache.set(jobId, entry)
  try {
    const count = await entry.promise
    entry.expiresAt = Date.now() + HERMES_RUN_COUNT_CACHE_TTL_MS
    return count
  } catch (error) {
    if (hermesRunCountCache.get(jobId) === entry) {
      hermesRunCountCache.delete(jobId)
    }
    throw error
  }
}
