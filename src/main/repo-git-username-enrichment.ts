import type { Repo } from '../shared/types'
import { resolveLocalGitUsernameDetailed } from './git/git-username'
import { getRepoLocationCacheKey } from './repo-location-cache-key'

export { REPO_LOCATION_CACHE_KEY_MAX_BYTES } from './repo-location-cache-key'

type RepoUsernameStore = {
  getRepos(): Repo[]
  setResolvedRepoGitUsername(id: string, username: string): boolean
}

type EnrichmentOptions = {
  onChanged?: () => void
}

export const REPO_GIT_USERNAME_ATTEMPT_MAX_ENTRIES = 512
// Why: resolution spawns git (and possibly gh) subprocesses, so run it at most
// once per repo location per app session — hydrateRepo serves the persisted
// value in between, and a relaunch picks up config changes.
const attemptedLocations = new Set<string>()
let enrichmentInFlight: Promise<void> | null = null
let rerunRequested = false

function rememberAttemptedLocation(locationKey: string): void {
  attemptedLocations.delete(locationKey)
  attemptedLocations.add(locationKey)
  while (attemptedLocations.size > REPO_GIT_USERNAME_ATTEMPT_MAX_ENTRIES) {
    const oldestLocation = attemptedLocations.values().next().value
    if (oldestLocation === undefined) {
      break
    }
    attemptedLocations.delete(oldestLocation)
  }
}

async function enrichRepoGitUsernamesInBackground(
  store: RepoUsernameStore,
  options: EnrichmentOptions
): Promise<void> {
  const candidates = store.getRepos().filter(
    (repo) =>
      repo.kind !== 'folder' &&
      // Why: SSH repo paths are remote; local git cannot inspect them. The
      // SSH username path (getSshGitUsername) stays caller-driven.
      !repo.connectionId &&
      !attemptedLocations.has(getRepoLocationCacheKey(repo) ?? '')
  )
  let changed = false
  for (const repo of candidates) {
    const locationKey = getRepoLocationCacheKey(repo)
    if (locationKey) {
      rememberAttemptedLocation(locationKey)
    }
    const { username, authoritative } = await resolveLocalGitUsernameDetailed(repo.path)
    // Why: a non-authoritative '' means a probe timed out and says nothing
    // about the account — keep the persisted value. An authoritative result
    // (including '') is the current truth: it must also CLEAR a stale
    // persisted username after the user removes github.user or logs out.
    if (!authoritative && !username) {
      continue
    }
    if (store.setResolvedRepoGitUsername(repo.id, username)) {
      changed = true
    }
  }
  if (changed) {
    options.onChanged?.()
  }
}

/**
 * Resolve git usernames for repos that haven't been probed this session, off
 * the caller's critical path. Fire-and-forget by design: repos:list must stay
 * subprocess-free (issue #7225 — a stuck sync probe froze startup for minutes).
 */
export function enrichRepoGitUsernames(
  store: RepoUsernameStore,
  options: EnrichmentOptions = {}
): void {
  if (enrichmentInFlight) {
    // Why: a repo added mid-pass would otherwise be dropped until some later
    // repos:list happens to fire — queue one follow-up pass instead.
    rerunRequested = true
    return
  }
  enrichmentInFlight = enrichRepoGitUsernamesInBackground(store, options)
    .catch((error: unknown) => {
      console.error('[repo-username] Failed to enrich git usernames:', error)
    })
    .finally(() => {
      enrichmentInFlight = null
      if (rerunRequested) {
        rerunRequested = false
        enrichRepoGitUsernames(store, options)
      }
    })
}

export async function flushRepoGitUsernameEnrichmentForTests(): Promise<void> {
  // A queued rerun replaces enrichmentInFlight when the first pass settles.
  while (enrichmentInFlight) {
    await enrichmentInFlight
  }
}

export function resetRepoGitUsernameEnrichmentForTests(): void {
  attemptedLocations.clear()
  enrichmentInFlight = null
  rerunRequested = false
}

export function getRepoGitUsernameAttemptCountForTests(): number {
  return attemptedLocations.size
}
