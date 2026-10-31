import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../shared/execution-host'
import type { Repo } from '../shared/repo-types'
import type { RepoHostTarget } from '../shared/repo-host-identity'
import { githubAvatarIcon, type RepoIcon } from '../shared/repo-icon'
import { isUnresolvedSshHostAlias } from '../shared/git-remote-host-alias'
import { getProjectProviderIdentity } from '../shared/project-host-setup-projection'
import { getStoredRepoExecutionHostId } from './repo-execution-host'
import { probeGitRemoteIdentity } from './repo-git-remote-identity'
import { getProjectRuntimeReadGitOptions } from './project-runtime-git-options'
import { isLocalGitRuntimeRouterInstalled } from './git/command-runner/local-git-runtime-route'
import type { ProjectRuntimeResolutionStore } from './local-project-runtime-resolution'
import { isWslMoveRepoBlocked } from './persistence/moving-wsl-projects/wsl-move-background-backoff'
import { blockedWslDistroForPath, wslDistroForPath } from './wsl/wsl-unc-access-gate'

const NO_IDENTITY_RETRY_TTL_MS = 5 * 60 * 1000
// Refresh renamed/transferred projects without probing on every list call.
const RESOLVED_IDENTITY_REFRESH_TTL_MS = 6 * 60 * 60 * 1000
// Avoid probing every resolved repo immediately after a restart.
const RESOLVED_IDENTITY_REFRESH_STARTUP_DELAY_MS = 5 * 60 * 1000
// Bound speculative probes so large repo lists do not stall a sweep.
const MAX_IDENTITY_REFRESHES_PER_SWEEP = 4

type RepoIdentityStore = ProjectRuntimeResolutionStore & {
  getRepos(): Repo[]
  getRepo?(id: string, hostId?: ExecutionHostId): Repo | undefined
  updateRepo(
    target: RepoHostTarget,
    updates: Pick<Partial<Repo>, 'gitRemoteIdentity' | 'repoIcon'>
  ): Repo | null
}

type EnrichmentOptions = {
  onChanged?: () => void
}

type InFlightProbe = {
  controller: AbortController
  promise: Promise<boolean>
}

const inFlightProbesByLocation = new Map<string, InFlightProbe>()
const probeRetryAfterByLocation = new Map<string, number>()
// Use stable callback references: coalesced callers share notifications until all reruns settle.
const pendingChangeListeners = new Set<() => void>()
let sweepInFlight: Promise<void> | null = null
let rerunRequested = false

function getRepoLocationKey(repo: Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>): string {
  return `${getRepoExecutionHostId(repo)}\0${repo.path}`
}

// Bare runtime stamps address files here; nested SSH targets belong to the peer.
function getRepoProbeHostId(repo: Repo): ExecutionHostId | null {
  const hostId = getStoredRepoExecutionHostId(repo)
  return hostId === LOCAL_EXECUTION_HOST_ID && getRepoSshConnectionId(repo) ? null : hostId
}

function getCurrentRepo(store: RepoIdentityStore, snapshot: Repo): Repo | undefined {
  const hostId = getRepoExecutionHostId(snapshot)
  const found = store.getRepo?.(snapshot.id, hostId)
  return found && getRepoExecutionHostId(found) === hostId
    ? found
    : store
        .getRepos()
        .find((repo) => repo.id === snapshot.id && getRepoExecutionHostId(repo) === hostId)
}

function isSameProbedRepo(snapshot: Repo, current: Repo | undefined): current is Repo {
  return (
    !!current &&
    current.kind !== 'folder' &&
    current.path === snapshot.path &&
    getRepoExecutionHostId(current) === getRepoExecutionHostId(snapshot)
  )
}

function shouldWriteProbedIdentity(current: Repo, probed: Repo['gitRemoteIdentity']): boolean {
  const existing = current.gitRemoteIdentity
  if (!existing) {
    // Repeated no-remote answers must not churn repo-list consumers.
    return !(probed === null && existing === null)
  }
  // Missing identities permit access; retain resolved identities when probes find nothing.
  return !!probed && probed.canonicalKey !== existing.canonicalKey
}

function getAutomaticGitHubIconRefresh(
  current: Repo,
  probed: NonNullable<Repo['gitRemoteIdentity']>
): RepoIcon | undefined {
  if (
    (current.upstream?.owner && current.upstream.repo) ||
    current.repoIcon?.type !== 'image' ||
    current.repoIcon.source !== 'github'
  ) {
    return undefined
  }
  const identity = getProjectProviderIdentity({
    upstream: null,
    repoIcon: undefined,
    gitRemoteIdentity: probed
  })
  if (!identity || (identity.host && isUnresolvedSshHostAlias(identity.host))) {
    return undefined
  }
  const icon = githubAvatarIcon(identity)
  return icon.type === 'image' &&
    current.repoIcon.src === icon.src &&
    current.repoIcon.label === icon.label
    ? undefined
    : icon
}

function writeIdentity(
  store: RepoIdentityStore,
  snapshot: Repo,
  gitRemoteIdentity: Repo['gitRemoteIdentity']
): boolean {
  if (!getRepoProbeHostId(snapshot)) {
    return false
  }
  const current = getCurrentRepo(store, snapshot)
  if (!isSameProbedRepo(snapshot, current)) {
    return false
  }
  const writeRemote = shouldWriteProbedIdentity(current, gitRemoteIdentity)
  const icon = gitRemoteIdentity
    ? getAutomaticGitHubIconRefresh(current, gitRemoteIdentity)
    : undefined
  // Store writes match the row's stamp even when its files are probed locally.
  const update = (updates: Pick<Partial<Repo>, 'gitRemoteIdentity' | 'repoIcon'>): Repo | null => {
    return store.updateRepo(snapshot, updates)
  }
  if (icon) {
    return !!update({ ...(writeRemote ? { gitRemoteIdentity } : {}), repoIcon: icon })
  }
  return writeRemote && !!update({ gitRemoteIdentity })
}

async function enrichRepoGitRemoteIdentity(store: RepoIdentityStore, repo: Repo): Promise<boolean> {
  const hostId = getRepoProbeHostId(repo)
  // Leave no deadline so the first sweep after a move can retry.
  if (!hostId || isWslMoveRepoBlocked(repo)) {
    return false
  }
  const locationKey = getRepoLocationKey(repo)
  const retryAfter = probeRetryAfterByLocation.get(locationKey) ?? 0
  if (retryAfter > Date.now()) {
    return false
  }
  const inFlight = inFlightProbesByLocation.get(locationKey)
  if (inFlight) {
    return inFlight.promise
  }
  // Resolved repos on unreachable hosts need no frequent retries.
  const missTtlMs = repo.gitRemoteIdentity
    ? RESOLVED_IDENTITY_REFRESH_TTL_MS
    : NO_IDENTITY_RETRY_TTL_MS
  const controller = new AbortController()
  const promise = (async () => {
    // A local project's runtime may run its Git in a distro, whatever its path.
    const git = getProjectRuntimeReadGitOptions(store, repo)
    // E9: git on a stopped distro's repo boots it; no deadline, so the next sweep retries once it runs.
    // Checked synchronously first so host repos keep probing without an extra await.
    if (
      wslDistroForPath(repo.path, git.wslDistro) &&
      (await blockedWslDistroForPath(repo.path, git.wslDistro))
    ) {
      return false
    }
    const result = await probeGitRemoteIdentity(repo.path, hostId, {
      signal: controller.signal,
      // Only the D1c router reads it, to wait for a stopped distro; main's sweep keeps its tier.
      ...(isLocalGitRuntimeRouterInstalled() ? { admissionTier: 'background' as const } : {}),
      ...git
    })
    // Aborted probes resolve as unavailable; prevent retired probes from re-seeding deadlines.
    if (controller.signal.aborted) {
      return false
    }
    if (isWslMoveRepoBlocked(repo)) {
      probeRetryAfterByLocation.delete(locationKey)
      return false
    }
    if (result.status !== 'resolved') {
      probeRetryAfterByLocation.set(locationKey, Date.now() + missTtlMs)
      // Unreachable hosts leave identity pending; only a successful git read can settle no-remote.
      return result.status === 'no-remote' ? writeIdentity(store, repo, null) : false
    }

    probeRetryAfterByLocation.set(locationKey, Date.now() + RESOLVED_IDENTITY_REFRESH_TTL_MS)
    return writeIdentity(store, repo, result.identity)
  })().finally(() => {
    // Retirement may have replaced this entry while the probe was running.
    if (inFlightProbesByLocation.get(locationKey)?.controller === controller) {
      inFlightProbesByLocation.delete(locationKey)
    }
  })
  inFlightProbesByLocation.set(locationKey, { controller, promise })
  return promise
}

function isIdentityRefreshDue(repo: Repo, now: number): boolean {
  const locationKey = getRepoLocationKey(repo)
  const dueAt = probeRetryAfterByLocation.get(locationKey)
  if (dueAt === undefined) {
    probeRetryAfterByLocation.set(locationKey, now + RESOLVED_IDENTITY_REFRESH_STARTUP_DELAY_MS)
    return false
  }
  return dueAt <= now
}

function retireRemovedLocations(allRepos: Repo[]): void {
  const liveKeys = new Set(
    allRepos.filter((repo) => repo.kind !== 'folder').map(getRepoLocationKey)
  )
  for (const locationKey of probeRetryAfterByLocation.keys()) {
    if (!liveKeys.has(locationKey)) {
      probeRetryAfterByLocation.delete(locationKey)
    }
  }
  for (const [locationKey, entry] of inFlightProbesByLocation) {
    // A wedged probe may never reach finally; retire it before this location can be re-added.
    if (!liveKeys.has(locationKey)) {
      entry.controller.abort()
      inFlightProbesByLocation.delete(locationKey)
    }
  }
}

function selectEnrichmentCandidates(store: RepoIdentityStore): Repo[] {
  const now = Date.now()
  const repos = store
    .getRepos()
    .filter((repo) => repo.kind !== 'folder' && getRepoProbeHostId(repo) !== null)
  // Retry settled null markers: repos can gain remotes later.
  const candidates = repos.filter((repo) => !repo.gitRemoteIdentity)
  let refreshes = 0
  for (const repo of repos) {
    if (refreshes >= MAX_IDENTITY_REFRESHES_PER_SWEEP) {
      break
    }
    if (repo.gitRemoteIdentity && isIdentityRefreshDue(repo, now)) {
      candidates.push(repo)
      refreshes += 1
    }
  }
  return candidates
}

async function enrichMissingRepoGitRemoteIdentitiesInBackground(
  store: RepoIdentityStore
): Promise<void> {
  const candidates = selectEnrichmentCandidates(store)
  let changed = false
  for (const repo of candidates) {
    // Snapshot the probed location so store mutations cannot bypass stale-write checks.
    if (await enrichRepoGitRemoteIdentity(store, { ...repo })) {
      changed = true
    }
  }
  if (changed) {
    for (const listener of pendingChangeListeners) {
      listener()
    }
  }
}

export function enrichMissingRepoGitRemoteIdentities(
  store: RepoIdentityStore,
  options: EnrichmentOptions = {}
): void {
  // Retire even during a stuck sweep so removed repos do not retain probes.
  try {
    retireRemovedLocations(store.getRepos())
  } catch (error: unknown) {
    console.error('[repo-identity] Failed to retire removed repo locations:', error)
  }
  if (options.onChanged) {
    pendingChangeListeners.add(options.onChanged)
  }
  if (sweepInFlight) {
    // A repo added mid-pass needs a follow-up without stacking whole sweeps.
    rerunRequested = true
    return
  }
  sweepInFlight = enrichMissingRepoGitRemoteIdentitiesInBackground(store)
    .catch((error: unknown) => {
      console.error('[repo-identity] Failed to enrich git remote identities:', error)
    })
    .finally(() => {
      sweepInFlight = null
      if (rerunRequested) {
        rerunRequested = false
        enrichMissingRepoGitRemoteIdentities(store)
      } else {
        // Coalesced callers still need notifications from queued reruns.
        pendingChangeListeners.clear()
      }
    })
}

export async function flushRepoGitRemoteIdentityEnrichmentForTests(): Promise<void> {
  // A queued rerun replaces sweepInFlight when the current pass settles.
  while (sweepInFlight) {
    await sweepInFlight
  }
  await Promise.all([...inFlightProbesByLocation.values()].map((entry) => entry.promise))
}

export function resetRepoGitRemoteIdentityEnrichmentForTests(): void {
  for (const entry of inFlightProbesByLocation.values()) {
    entry.controller.abort()
  }
  inFlightProbesByLocation.clear()
  probeRetryAfterByLocation.clear()
  pendingChangeListeners.clear()
  sweepInFlight = null
  rerunRequested = false
}
