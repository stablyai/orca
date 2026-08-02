import type { Repo } from '../shared/types'
import { probeGitRemoteIdentity } from './repo-git-remote-identity'

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

function writeIdentity(
  store: RepoIdentityStore,
  snapshot: Repo,
  gitRemoteIdentity: Repo['gitRemoteIdentity']
): boolean {
  const current = getCurrentRepo(store, snapshot.id)
  if (!isSameUnenrichedRepo(snapshot, current)) {
    return false
  }
  // Why: the no-remote marker is re-derived on every retry; skip the redundant
  // write so repo-list consumers do not churn.
  if (gitRemoteIdentity === null && current?.gitRemoteIdentity === null) {
    return false
  }
  return !!store.updateRepo(snapshot.id, { gitRemoteIdentity })
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
    const result = await probeGitRemoteIdentity(repo.path, repo.connectionId)
    if (result.status !== 'resolved') {
      // Why: repos without a parseable remote are common; cache misses briefly so
      // list calls stay cheap while still allowing recent remote changes to land.
      noIdentityRetryAfterByLocation.set(locationKey, Date.now() + NO_IDENTITY_RETRY_TTL_MS)
      // Why: only a probe that actually reached git settles "no usable remote".
      // An unreachable host leaves the identity unknown so consumers can keep
      // treating the repo as pending instead of ineligible.
      return result.status === 'no-remote' ? writeIdentity(store, repo, null) : false
    }

    noIdentityRetryAfterByLocation.delete(locationKey)
    return writeIdentity(store, repo, result.identity)
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
  // Why: the settled `null` marker stays a candidate on purpose — a repo that
  // gains a remote later must still resolve. Do not tighten this to
  // `=== undefined`; the retry TTL already bounds the cost and `writeIdentity`
  // skips the redundant rewrite.
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
