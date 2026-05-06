// Why: module-level cache lets the home screen pre-populate worktree data
// so the host detail page can render instantly on navigation instead of
// waiting for a fresh RPC connection + fetch cycle.

type CachedWorktrees = {
  worktrees: unknown[]
  at: number
}

const cache = new Map<string, CachedWorktrees>()

const MAX_AGE_MS = 30_000
const MAX_ENTRIES = 20

export function setCachedWorktrees(hostId: string, worktrees: unknown[]): void {
  // Why: Map.set on an existing key does not move it to the end of iteration
  // order. Delete first so the re-inserted key becomes the newest entry,
  // giving us true LRU eviction when the cap is hit.
  cache.delete(hostId)
  cache.set(hostId, { worktrees, at: Date.now() })
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
}

export function getCachedWorktrees(hostId: string): unknown[] | null {
  const entry = cache.get(hostId)
  if (!entry) return null
  if (Date.now() - entry.at > MAX_AGE_MS) {
    cache.delete(hostId)
    return null
  }
  return entry.worktrees
}
