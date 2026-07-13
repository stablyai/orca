import type { Repo } from '../shared/types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import {
  LOCAL_GIT_USERNAME_TIMEOUT_RETRY_MS,
  resolveLocalGitUsernameDetailed
} from './git/git-username'

export const MAX_REPO_GIT_USERNAME_ATTEMPTED_LOCATIONS = 2048

type RepoUsernameStore = {
  getRepos(): Repo[]
  setResolvedRepoGitUsername(
    id: string,
    username: string,
    expectedLifecycle?: RepoLifecycle
  ): boolean
}

type RepoLifecycle = Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId' | 'addedAt'>

type EnrichmentOptions = {
  onChanged?: () => void
}

type EnrichmentRequest = {
  store: RepoUsernameStore
  options: EnrichmentOptions
}

type InFlightEnrichment = {
  generation: number
  promise: Promise<void>
}

// null means this lifecycle completed authoritatively for the session; a
// timestamp keeps the whole git+gh pipeline quiet until a timed-out retry.
const attemptedLifecycles = new Map<string, number | null>()
const storeIds = new WeakMap<RepoUsernameStore, number>()
let nextStoreId = 1
let generation = 0
let enrichmentInFlight: InFlightEnrichment | null = null
let pendingRequest: EnrichmentRequest | null = null

function getStoreId(store: RepoUsernameStore): number {
  const existing = storeIds.get(store)
  if (existing !== undefined) {
    return existing
  }
  const id = nextStoreId++
  storeIds.set(store, id)
  return id
}

function getRepoLifecycleKey(store: RepoUsernameStore, repo: Repo): string {
  return [
    getStoreId(store),
    repo.executionHostId ?? 'default-host',
    repo.connectionId ?? 'local',
    repo.path,
    repo.id,
    repo.addedAt
  ].join('\0')
}

function getStoreKeyPrefix(store: RepoUsernameStore): string {
  return `${getStoreId(store)}\0`
}

function pruneAttemptedLifecycles(
  store: RepoUsernameStore,
  liveLifecycleKeys: ReadonlySet<string>
): void {
  const storeKeyPrefix = getStoreKeyPrefix(store)
  for (const lifecycleKey of attemptedLifecycles.keys()) {
    if (lifecycleKey.startsWith(storeKeyPrefix) && !liveLifecycleKeys.has(lifecycleKey)) {
      attemptedLifecycles.delete(lifecycleKey)
    }
  }
}

function rememberAttemptedLifecycle(lifecycleKey: string, retryAt: number | null = null): void {
  attemptedLifecycles.delete(lifecycleKey)
  attemptedLifecycles.set(lifecycleKey, retryAt)
  while (attemptedLifecycles.size > MAX_REPO_GIT_USERNAME_ATTEMPTED_LOCATIONS) {
    const oldestLifecycleKey = attemptedLifecycles.keys().next().value
    if (oldestLifecycleKey === undefined) {
      break
    }
    attemptedLifecycles.delete(oldestLifecycleKey)
  }
}

function isLifecycleAttemptDeferred(lifecycleKey: string, now: number): boolean {
  const retryAt = attemptedLifecycles.get(lifecycleKey)
  if (retryAt === undefined) {
    return false
  }
  if (retryAt === null || retryAt > now) {
    return true
  }
  attemptedLifecycles.delete(lifecycleKey)
  return false
}

function hasSameRepoLifecycle(snapshot: RepoLifecycle, current: Repo): boolean {
  return (
    current.id === snapshot.id &&
    current.addedAt === snapshot.addedAt &&
    current.path === snapshot.path &&
    (current.connectionId ?? null) === (snapshot.connectionId ?? null) &&
    (current.executionHostId ?? null) === (snapshot.executionHostId ?? null)
  )
}

function getCurrentRepo(store: RepoUsernameStore, snapshot: RepoLifecycle): Repo | undefined {
  return store.getRepos().find((repo) => hasSameRepoLifecycle(snapshot, repo))
}

function supportsLocalGitUsernameProbe(repo: Repo): boolean {
  // Why: runtime and SSH paths belong to another execution host; local git/gh
  // must never resolve or clear credentials for those repos.
  return repo.kind !== 'folder' && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
}

function isSameLocalGitRepo(snapshot: Repo, current: Repo | undefined): boolean {
  return (
    !!current &&
    hasSameRepoLifecycle(snapshot, current) &&
    supportsLocalGitUsernameProbe(current) &&
    current.kind !== 'folder'
  )
}

async function enrichRepoGitUsernamesInBackground(
  store: RepoUsernameStore,
  options: EnrichmentOptions,
  taskGeneration: number
): Promise<void> {
  const repos = store.getRepos()
  // Why: SSH repo paths are remote; local git cannot inspect them. The SSH
  // username path (getSshGitUsername) stays caller-driven.
  const localGitRepos = repos.filter(supportsLocalGitUsernameProbe)
  const liveLifecycleKeys = new Set(localGitRepos.map((repo) => getRepoLifecycleKey(store, repo)))
  pruneAttemptedLifecycles(store, liveLifecycleKeys)
  const now = Date.now()
  const candidates = localGitRepos.filter(
    (repo) => !isLifecycleAttemptDeferred(getRepoLifecycleKey(store, repo), now)
  )
  let changed = false
  for (const candidate of candidates) {
    if (generation !== taskGeneration) {
      return
    }
    // Why: a background subprocess can outlive removal, rename, or ID reuse;
    // snapshot the durable lifecycle fields before awaiting it.
    const repo = { ...candidate }
    const lifecycleKey = getRepoLifecycleKey(store, repo)
    rememberAttemptedLifecycle(lifecycleKey)
    const { username, authoritative } = await resolveLocalGitUsernameDetailed(repo.path)
    if (generation !== taskGeneration) {
      return
    }
    if (!isSameLocalGitRepo(repo, getCurrentRepo(store, repo))) {
      // Why: the replacement lifecycle must be allowed to schedule its own probe.
      attemptedLifecycles.delete(lifecycleKey)
      continue
    }
    // Why: a non-authoritative '' means a probe timed out and says nothing
    // about the account. An authoritative result (including '') is current truth.
    if (!authoritative && !username) {
      // Why: the resolver's gh cooldown alone still allows all earlier git
      // probes to repeat on every repos:list; defer the entire lifecycle pipeline.
      rememberAttemptedLifecycle(lifecycleKey, Date.now() + LOCAL_GIT_USERNAME_TIMEOUT_RETRY_MS)
      continue
    }
    if (store.setResolvedRepoGitUsername(repo.id, username, repo)) {
      changed = true
    }
  }
  if (changed && generation === taskGeneration) {
    options.onChanged?.()
  }
}

function startEnrichment(request: EnrichmentRequest, taskGeneration: number): void {
  const inFlight: InFlightEnrichment = {
    generation: taskGeneration,
    promise: Promise.resolve()
  }
  inFlight.promise = enrichRepoGitUsernamesInBackground(
    request.store,
    request.options,
    taskGeneration
  )
    .catch((error: unknown) => {
      console.error('[repo-username] Failed to enrich git usernames:', error)
    })
    .finally(() => {
      if (generation !== taskGeneration || enrichmentInFlight !== inFlight) {
        return
      }
      enrichmentInFlight = null
      const nextRequest = pendingRequest
      pendingRequest = null
      if (nextRequest) {
        startEnrichment(nextRequest, taskGeneration)
      }
    })
  enrichmentInFlight = inFlight
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
  const request = { store, options }
  if (enrichmentInFlight?.generation === generation) {
    // Why: only one follow-up pass is useful; retain its newest store/callback
    // because that request reflects the latest caller state.
    pendingRequest = request
    return
  }
  startEnrichment(request, generation)
}

export async function flushRepoGitUsernameEnrichmentForTests(): Promise<void> {
  const flushGeneration = generation
  while (enrichmentInFlight?.generation === flushGeneration) {
    await enrichmentInFlight.promise
  }
}

export function resetRepoGitUsernameEnrichmentForTests(): void {
  generation++
  attemptedLifecycles.clear()
  enrichmentInFlight = null
  pendingRequest = null
}

export function getRepoGitUsernameAttemptedLocationCountForTests(): number {
  return attemptedLifecycles.size
}

export function hasRepoGitUsernameAttemptedLocationForTests(repo: Repo): boolean {
  const suffix = `\0${repo.path}\0${repo.id}\0${repo.addedAt}`
  return [...attemptedLifecycles.keys()].some((key) => key.endsWith(suffix))
}
