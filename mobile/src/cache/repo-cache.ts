// Why: repo metadata is mostly decorative and changes rarely. Keeping a short
// host-scoped cache lets workspace creation open from the last known list while
// a fresh repo.list refresh happens in the background.

type CachedRepos = {
  repos: unknown[]
  at: number
}

const cache = new Map<string, CachedRepos>()

const MAX_AGE_MS = 60_000
const MAX_ENTRIES = 20

export function setCachedRepos(hostId: string, repos: unknown[]): void {
  cache.delete(hostId)
  cache.set(hostId, { repos, at: Date.now() })
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest) {
      cache.delete(oldest)
    }
  }
}

export function getCachedRepos(hostId: string): unknown[] | null {
  const entry = cache.get(hostId)
  if (!entry) {
    return null
  }
  if (Date.now() - entry.at > MAX_AGE_MS) {
    cache.delete(hostId)
    return null
  }
  return entry.repos
}
