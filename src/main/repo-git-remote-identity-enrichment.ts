import type { Repo } from '../shared/types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import { detectGitRemoteIdentity } from './repo-git-remote-identity'
import * as coalescing from './repo-git-remote-identity-coalescing'

const NO_IDENTITY_RETRY_TTL_MS = 5 * 60 * 1000
export const MAX_REPO_REMOTE_IDENTITY_NEGATIVE_CACHE_LOCATIONS = 512

type RepoIdentityStore = {
  getRepos(): Repo[]
  updateRepo(
    id: string,
    updates: Pick<Partial<Repo>, 'gitRemoteIdentity'>,
    expectedLifecycle?: RepoLifecycle
  ): Repo | null
}

type RepoLifecycle = Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId' | 'addedAt'>

type EnrichmentOptions = {
  onChanged?: () => void
  notificationChannel?: coalescing.RepoIdentityNotificationChannel
  /** Internal authority: this process owns runtime-stamped repo paths. */
  probeRuntimeHostPaths?: boolean
}

const storeIds = new WeakMap<RepoIdentityStore, number>()
const inFlightProbesByLifecycle = new Map<string, Promise<boolean>>()
const noIdentityRetryAfterByLifecycle = new Map<string, number>()
const backgroundTasks = new Set<coalescing.RepoIdentityBackgroundTask>()
let backgroundTaskByStore = new WeakMap<RepoIdentityStore, coalescing.RepoIdentityBackgroundTask>()
let nextStoreId = 1
let generation = 0

function getStoreId(store: RepoIdentityStore): number {
  const existing = storeIds.get(store)
  if (existing !== undefined) {
    return existing
  }
  const id = nextStoreId++
  storeIds.set(store, id)
  return id
}

function getRepoLifecycleKey(store: RepoIdentityStore, repo: Repo): string {
  return [
    getStoreId(store),
    repo.executionHostId ?? 'default-host',
    repo.connectionId ?? 'local',
    repo.path,
    repo.id,
    repo.addedAt
  ].join('\0')
}

function getStoreKeyPrefix(store: RepoIdentityStore): string {
  return `${getStoreId(store)}\0`
}

function pruneNoIdentityRetryLifecycles(
  store: RepoIdentityStore,
  liveLifecycleKeys: ReadonlySet<string>,
  now: number
): void {
  const storeKeyPrefix = getStoreKeyPrefix(store)
  for (const [lifecycleKey, retryAfter] of noIdentityRetryAfterByLifecycle) {
    if (
      lifecycleKey.startsWith(storeKeyPrefix) &&
      (retryAfter <= now || !liveLifecycleKeys.has(lifecycleKey))
    ) {
      noIdentityRetryAfterByLifecycle.delete(lifecycleKey)
    }
  }
}

function rememberNoIdentityRetryLifecycle(lifecycleKey: string, retryAfter: number): void {
  noIdentityRetryAfterByLifecycle.delete(lifecycleKey)
  noIdentityRetryAfterByLifecycle.set(lifecycleKey, retryAfter)
  while (noIdentityRetryAfterByLifecycle.size > MAX_REPO_REMOTE_IDENTITY_NEGATIVE_CACHE_LOCATIONS) {
    const oldestLifecycleKey = noIdentityRetryAfterByLifecycle.keys().next().value
    if (oldestLifecycleKey === undefined) {
      break
    }
    noIdentityRetryAfterByLifecycle.delete(oldestLifecycleKey)
  }
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

function getCurrentRepo(store: RepoIdentityStore, snapshot: RepoLifecycle): Repo | undefined {
  return store.getRepos().find((repo) => hasSameRepoLifecycle(snapshot, repo))
}

function supportsGitRemoteIdentityProbe(repo: Repo, probeRuntimeHostPaths: boolean): boolean {
  const executionHostId = getRepoExecutionHostId(repo)
  // Why: detectGitRemoteIdentity can execute only on this machine or through
  // an SSH connection; runtime-host paths need their owning runtime to probe.
  return (
    repo.kind !== 'folder' &&
    (!!repo.connectionId ||
      executionHostId === LOCAL_EXECUTION_HOST_ID ||
      (probeRuntimeHostPaths && executionHostId.startsWith('runtime:')))
  )
}

function isSameUnenrichedRepo(
  snapshot: Repo,
  current: Repo | undefined,
  probeRuntimeHostPaths: boolean
): boolean {
  return (
    !!current &&
    hasSameRepoLifecycle(snapshot, current) &&
    supportsGitRemoteIdentityProbe(current, probeRuntimeHostPaths) &&
    !current.gitRemoteIdentity &&
    current.kind !== 'folder'
  )
}

async function enrichRepoGitRemoteIdentity(
  store: RepoIdentityStore,
  repo: Repo,
  taskGeneration: number,
  retrySnapshot: ReadonlyMap<string, number>,
  probeRuntimeHostPaths: boolean
): Promise<boolean> {
  const lifecycleKey = getRepoLifecycleKey(store, repo)
  const retryAfterAtPassStart = retrySnapshot.get(lifecycleKey) ?? 0
  if (retryAfterAtPassStart > Date.now()) {
    // Why: a cap eviction earlier in this pass must not turn every remaining
    // cached repo into a new git probe cascade.
    if (noIdentityRetryAfterByLifecycle.get(lifecycleKey) === retryAfterAtPassStart) {
      rememberNoIdentityRetryLifecycle(lifecycleKey, retryAfterAtPassStart)
    }
    return false
  }
  const inFlight = inFlightProbesByLifecycle.get(lifecycleKey)
  if (inFlight) {
    return inFlight
  }
  const probe = (async () => {
    const identity = await detectGitRemoteIdentity(repo.path, repo.connectionId)
    if (
      generation !== taskGeneration ||
      !isSameUnenrichedRepo(repo, getCurrentRepo(store, repo), probeRuntimeHostPaths)
    ) {
      return false
    }
    if (!identity) {
      // Why: repos without a parseable remote are common; cache misses briefly so
      // list calls stay cheap while still allowing recent remote changes to land.
      rememberNoIdentityRetryLifecycle(lifecycleKey, Date.now() + NO_IDENTITY_RETRY_TTL_MS)
      return false
    }

    noIdentityRetryAfterByLifecycle.delete(lifecycleKey)
    return !!store.updateRepo(repo.id, { gitRemoteIdentity: identity }, repo)
  })().finally(() => {
    if (generation === taskGeneration && inFlightProbesByLifecycle.get(lifecycleKey) === probe) {
      inFlightProbesByLifecycle.delete(lifecycleKey)
    }
  })
  inFlightProbesByLifecycle.set(lifecycleKey, probe)
  return probe
}

async function enrichMissingRepoGitRemoteIdentitiesInBackground(
  store: RepoIdentityStore,
  request: coalescing.RepoIdentityEnrichmentRequest,
  taskGeneration: number
): Promise<boolean> {
  const repos = store.getRepos()
  const probeRuntimeHostPaths = request.probeRuntimeHostPaths
  // Why: a desktop pass cannot probe runtime-owned paths, but it must not evict
  // the owning runtime's TTL entry while that same lifecycle is still persisted.
  const liveLifecycleKeys = new Set(repos.map((repo) => getRepoLifecycleKey(store, repo)))
  pruneNoIdentityRetryLifecycles(store, liveLifecycleKeys, Date.now())
  const retrySnapshot = new Map(noIdentityRetryAfterByLifecycle)
  const candidates = repos.filter(
    (repo) => supportsGitRemoteIdentityProbe(repo, probeRuntimeHostPaths) && !repo.gitRemoteIdentity
  )
  let changed = false
  for (const repo of candidates) {
    if (generation !== taskGeneration) {
      return false
    }
    // Why: enrichment runs later; capture the lifecycle fields before awaiting
    // so a removed, renamed, or ID-reused repo cannot receive stale data.
    if (
      await enrichRepoGitRemoteIdentity(
        store,
        { ...repo },
        taskGeneration,
        retrySnapshot,
        probeRuntimeHostPaths
      )
    ) {
      changed = true
    }
  }
  return changed && generation === taskGeneration
}

async function runBackgroundTask(
  store: RepoIdentityStore,
  task: coalescing.RepoIdentityBackgroundTask,
  initialRequest: coalescing.RepoIdentityEnrichmentRequest
): Promise<void> {
  let request = initialRequest
  let changed = false
  while (generation === task.generation) {
    try {
      changed =
        (await enrichMissingRepoGitRemoteIdentitiesInBackground(
          store,
          request,
          task.generation
        )) || changed
    } catch (error: unknown) {
      console.error('[repo-identity] Failed to enrich git remote identities:', error)
    }
    if (generation !== task.generation) {
      return
    }
    const pendingRequest = task.pendingRequest
    task.pendingRequest = null
    if (!pendingRequest) {
      break
    }
    request = pendingRequest
  }
  if (changed && generation === task.generation) {
    coalescing.notifyRepoIdentityConsumers(task.onChangedByChannel)
  }
}

function startBackgroundEnrichment(
  store: RepoIdentityStore,
  options: EnrichmentOptions,
  taskGeneration: number
): void {
  const task: coalescing.RepoIdentityBackgroundTask = {
    generation: taskGeneration,
    promise: Promise.resolve(),
    pendingRequest: null,
    onChangedByChannel: new Map()
  }
  coalescing.rememberRepoIdentityNotification(
    task.onChangedByChannel,
    options.notificationChannel,
    options.onChanged
  )
  backgroundTaskByStore.set(store, task)
  task.promise = runBackgroundTask(
    store,
    task,
    coalescing.enrichmentRequest(options.probeRuntimeHostPaths === true)
  )
    .finally(() => {
      backgroundTasks.delete(task)
      task.onChangedByChannel.clear()
      task.pendingRequest = null
      if (generation === taskGeneration && backgroundTaskByStore.get(store) === task) {
        backgroundTaskByStore.delete(store)
      }
    })
  backgroundTasks.add(task)
}

export function enrichMissingRepoGitRemoteIdentities(
  store: RepoIdentityStore,
  options: EnrichmentOptions = {}
): void {
  const existing = backgroundTaskByStore.get(store)
  if (existing?.generation === generation) {
    // Why: list RPCs can repeat while git is slow; retain one bounded rerun and
    // one latest callback per semantic consumer instead of one task per request.
    existing.pendingRequest = coalescing.mergePendingEnrichmentRequest(
      existing.pendingRequest,
      options.probeRuntimeHostPaths === true
    )
    coalescing.rememberRepoIdentityNotification(
      existing.onChangedByChannel,
      options.notificationChannel,
      options.onChanged
    )
    return
  }
  startBackgroundEnrichment(store, options, generation)
}

export async function flushRepoGitRemoteIdentityEnrichmentForTests(): Promise<void> {
  const flushGeneration = generation
  while (true) {
    const tasks = [...backgroundTasks]
      .filter((task) => task.generation === flushGeneration)
      .map((task) => task.promise)
    if (tasks.length === 0) {
      return
    }
    await Promise.all(tasks)
  }
}

export function resetRepoGitRemoteIdentityEnrichmentForTests(): void {
  generation++
  backgroundTaskByStore = new WeakMap()
  inFlightProbesByLifecycle.clear()
  noIdentityRetryAfterByLifecycle.clear()
}

export function getRepoGitRemoteIdentityBackgroundTaskCountForTests(): number {
  return backgroundTasks.size
}

export function getRepoGitRemoteIdentityEnrichmentCountsForTests(): {
  inFlight: number
  negativeCache: number
} {
  return {
    inFlight: inFlightProbesByLifecycle.size,
    negativeCache: noIdentityRetryAfterByLifecycle.size
  }
}

export function hasRepoGitRemoteIdentityNegativeCacheForTests(repo: Repo): boolean {
  const suffix = `\0${repo.path}\0${repo.id}\0${repo.addedAt}`
  return [...noIdentityRetryAfterByLifecycle.keys()].some((key) => key.endsWith(suffix))
}
