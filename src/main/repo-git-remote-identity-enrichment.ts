import type { Repo } from '../shared/types'
import { detectGitRemoteIdentity } from './repo-git-remote-identity'

const NO_IDENTITY_RETRY_TTL_MS = 5 * 60 * 1000

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

function getRepoLocationKey(repo: Pick<Repo, 'path' | 'connectionId'>): string {
  return `${repo.connectionId ?? 'local'}\0${repo.path}`
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
  const locationKey = getRepoLocationKey(repo)
  const retryAfter = noIdentityRetryAfterByLocation.get(locationKey) ?? 0
  if (retryAfter > Date.now()) {
    return false
  }
  const inFlight = inFlightProbesByLocation.get(locationKey)
  if (inFlight) {
    return inFlight
  }
  const probe = (async () => {
    const identity = await detectGitRemoteIdentity(repo.path, repo.connectionId)
    if (!identity) {
      // Why: repos without a parseable remote are common; cache misses briefly so
      // list calls stay cheap while still allowing recent remote changes to land.
      noIdentityRetryAfterByLocation.set(locationKey, Date.now() + NO_IDENTITY_RETRY_TTL_MS)
      return false
    }

    noIdentityRetryAfterByLocation.delete(locationKey)
    const current = getCurrentRepo(store, repo.id)
    if (!isSameUnenrichedRepo(repo, current)) {
      return false
    }
    return !!store.updateRepo(repo.id, { gitRemoteIdentity: identity })
  })().finally(() => {
    if (inFlightProbesByLocation.get(locationKey) === probe) {
      inFlightProbesByLocation.delete(locationKey)
    }
  })
  inFlightProbesByLocation.set(locationKey, probe)
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
