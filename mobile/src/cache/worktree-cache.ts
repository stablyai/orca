// Home seeds module cache so host detail renders before reconnect/fetch.

type CachedWorktrees = {
  worktrees: unknown[]
  at: number
  // Only live host-listed rows can prove absence; persisted cold-start seeds cannot.
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
  // Late cold-start seed must neither erase proof nor truncate live host-listed rows used by Resume.
  if (options?.proven !== true && readFreshEntry(hostId)?.proven) {
    return
  }
  // Delete before Map.set to move key to newest position for LRU eviction.
  cache.delete(hostId)
  // Default unproven: unknown row origin cannot justify redirecting user from workspace.
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

// Return live host-listed rows only; expired/unproven entries cannot establish absence.
export function getProvenCachedWorktrees(hostId: string): unknown[] | null {
  const entry = readFreshEntry(hostId)
  return entry?.proven ? entry.worktrees : null
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
