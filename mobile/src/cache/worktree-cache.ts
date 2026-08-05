// Why: module-level cache lets the home screen pre-populate worktree data
// so the host detail page can render instantly on navigation instead of
// waiting for a fresh RPC connection + fetch cycle.

type CachedWorktrees = {
  worktrees: unknown[]
  at: number
  // Whether the host itself listed these rows this session, as opposed to a cold-start seed
  // rebuilt from a persisted snapshot. Only a proven list can prove a worktree *absent*.
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
  // Why: a cold-start snapshot seed landing after a live worktree.ps must not erase
  // the proof — or truncate the host-listed rows — the resume check depends on.
  if (options?.proven !== true && readFreshEntry(hostId)?.proven) {
    return
  }
  // Why: Map.set on an existing key does not move it to the end of iteration
  // order. Delete first so the re-inserted key becomes the newest entry,
  // giving us true LRU eviction when the cap is hit.
  cache.delete(hostId)
  // Default false: a caller that has not said where the rows came from must never be taken
  // as grounds for redirecting the user away from a workspace.
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

/** The rows only when the host listed them itself — null whenever absence cannot be trusted,
 *  which is every unproven or expired entry. */
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
