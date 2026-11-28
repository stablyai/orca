import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'
import { withBoundedCacheEntry } from '../../../../shared/github/cache/bounded-cache-entries'

type GitHubCache = PersistedState['githubCache']

// Desktop answers main wrote itself; the renderer saves its whole cache without having seen them.
const recorded = new Map<string, { fetchedAt: number; until: number }>()

export function noteMainRecordedPREntry(key: string, fetchedAt: number, until: number): void {
  recorded.set(key, { fetchedAt, until })
}

/** The renderer's cache save, keeping main's newer answers it has not caught up with yet. */
export function keepMainRecordedPREntries(
  incoming: GitHubCache,
  current: GitHubCache,
  now = Date.now()
): GitHubCache {
  let pr = incoming.pr
  for (const [key, mark] of recorded) {
    const ours = current.pr[key]
    const theirs = incoming.pr[key]
    // Past the backfill TTL the next scan re-reads it; another write or a newer renderer answer wins.
    if (
      now >= mark.until ||
      ours?.fetchedAt !== mark.fetchedAt ||
      (theirs && theirs.fetchedAt >= mark.fetchedAt)
    ) {
      recorded.delete(key)
      continue
    }
    pr = withBoundedCacheEntry(pr, key, ours)
  }
  return pr === incoming.pr ? incoming : { ...incoming, pr }
}
