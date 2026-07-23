import type { Repo } from '../shared/types'
import { detectGitRemoteIdentity } from './repo-git-remote-identity'
import { getRepoLocationCacheKey } from './repo-location-cache-key'

export { REPO_LOCATION_CACHE_KEY_MAX_BYTES } from './repo-location-cache-key'

const NO_IDENTITY_RETRY_TTL_MS = 5 * 60 * 1000
export const REPO_IDENTITY_NEGATIVE_CACHE_MAX_ENTRIES = 512

type RepoIdentityStore = {
  getRepos(): Repo[]
  getRepo?(id: string): Repo | undefined
  updateRepo(id: string, updates: Pick<Partial<Repo>, 'gitRemoteIdentity'>): Repo | null
}

type EnrichmentOptions = {
  onChanged?: () => void
}

const inFlightProbesByLocation = new Map<string, Promise<boolean>>()
const noIdentityRetryAfterByLocation = new Map<string, number>()

function pruneNoIdentityRetryCache(now: number): void {
  for (const [locationKey, retryAfter] of noIdentityRetryAfterByLocation) {
    if (retryAfter <= now) {
      noIdentityRetryAfterByLocation.delete(locationKey)
    }
  }
  while (noIdentityRetryAfterByLocation.size > REPO_IDENTITY_NEGATIVE_CACHE_MAX_ENTRIES) {
    const oldestLocation = noIdentityRetryAfterByLocation.keys().next().value
    if (oldestLocation === undefined) {
      break
    }
    noIdentityRetryAfterByLocation.delete(oldestLocation)
  }
}

function rememberNoIdentityRetry(locationKey: string, retryAfter: number): void {
  noIdentityRetryAfterByLocation.delete(locationKey)
  noIdentityRetryAfterByLocation.set(locationKey, retryAfter)
  pruneNoIdentityRetryCache(Date.now())
}

function getCurrentRepo(store: RepoIdentityStore, id: string): Repo | undefined {
  return store.getRepo?.(id) ?? store.getRepos().find((repo) => repo.id === id)
}

function isSameUnenrichedRepo(snapshot: Repo, current: Repo | undefined): boolean {
  return (
    !!current &&
    current.kind !== 'folder' &&
    !current.gitRemoteIdentity &&
    current.path === snapshot.path &&
    (current.connectionId ?? null) === (snapshot.connectionId ?? null)
  )
}

async function enrichRepoGitRemoteIdentity(store: RepoIdentityStore, repo: Repo): Promise<boolean> {
  const locationKey = getRepoLocationCacheKey(repo)
  const now = Date.now()
  pruneNoIdentityRetryCache(now)
  const retryAfter = locationKey ? (noIdentityRetryAfterByLocation.get(locationKey) ?? 0) : 0
  if (retryAfter > now) {
    return false
  }
  const inFlight = locationKey ? inFlightProbesByLocation.get(locationKey) : undefined
  if (inFlight) {
    return inFlight
  }
  const probe = (async () => {
    const identity = await detectGitRemoteIdentity(repo.path, repo.connectionId)
    if (!identity) {
      // Why: repos without a parseable remote are common; cache misses briefly so
      // list calls stay cheap while still allowing recent remote changes to land.
      if (locationKey) {
        rememberNoIdentityRetry(locationKey, Date.now() + NO_IDENTITY_RETRY_TTL_MS)
      }
      return false
    }

    if (locationKey) {
      noIdentityRetryAfterByLocation.delete(locationKey)
    }
    const current = getCurrentRepo(store, repo.id)
    if (!isSameUnenrichedRepo(repo, current)) {
      return false
    }
    return !!store.updateRepo(repo.id, { gitRemoteIdentity: identity })
  })().finally(() => {
    if (locationKey && inFlightProbesByLocation.get(locationKey) === probe) {
      inFlightProbesByLocation.delete(locationKey)
    }
  })
  if (locationKey) {
    inFlightProbesByLocation.set(locationKey, probe)
  }
  return probe
}

async function enrichMissingRepoGitRemoteIdentitiesInBackground(
  store: RepoIdentityStore,
  options: EnrichmentOptions
): Promise<void> {
  const candidates = store
    .getRepos()
    .filter((repo) => repo.kind !== 'folder' && !repo.gitRemoteIdentity)
  let changed = false
  for (const repo of candidates) {
    // Why: enrichment runs later; capture the location we probed so a mutable
    // store cannot make the stale-write guard compare against changed fields.
    if (await enrichRepoGitRemoteIdentity(store, { ...repo })) {
      changed = true
    }
  }
  if (changed) {
    options.onChanged?.()
  }
}

export function enrichMissingRepoGitRemoteIdentities(
  store: RepoIdentityStore,
  options: EnrichmentOptions = {}
): void {
  void enrichMissingRepoGitRemoteIdentitiesInBackground(store, options).catch((error: unknown) => {
    console.error('[repo-identity] Failed to enrich git remote identities:', error)
  })
}

export async function flushRepoGitRemoteIdentityEnrichmentForTests(): Promise<void> {
  await Promise.all(inFlightProbesByLocation.values())
}

export function resetRepoGitRemoteIdentityEnrichmentForTests(): void {
  inFlightProbesByLocation.clear()
  noIdentityRetryAfterByLocation.clear()
}

export function getRepoGitRemoteIdentityNegativeCacheSizeForTests(): number {
  return noIdentityRetryAfterByLocation.size
}
