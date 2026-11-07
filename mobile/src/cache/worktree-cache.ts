// Home seeds module cache so host detail renders before reconnect/fetch.

type CachedWorktrees = {
  worktrees: unknown[]
  at: number
  // Live host-listed rows; a persisted cold-start seed must not replace them.
  proven: boolean
}

const cache = new Map<string, CachedWorktrees>()

const MAX_AGE_MS = 30_000
const MAX_ENTRIES = 20

export function setCachedWorktrees(
  hostId: string,
  worktrees: unknown[],
  options?: { proven?: boolean }
): void {
  // A late cold-start seed must not truncate live host-listed rows.
  if (options?.proven !== true && readFreshEntry(hostId)?.proven) {
    return
  }
  // Delete before Map.set to move key to newest position for LRU eviction.
  cache.delete(hostId)
  cache.set(hostId, { worktrees, at: Date.now(), proven: options?.proven === true })
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest) {
      cache.delete(oldest)
    }
  }
}

export function getCachedWorktrees(hostId: string): unknown[] | null {
  return readFreshEntry(hostId)?.worktrees ?? null
}

function readFreshEntry(hostId: string): CachedWorktrees | null {
  const entry = cache.get(hostId)
  if (!entry) {
    return null
  }
  if (Date.now() - entry.at > MAX_AGE_MS) {
    cache.delete(hostId)
    return null
  }
  return entry
}
