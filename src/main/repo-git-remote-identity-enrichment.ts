import {
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../shared/execution-host'
import type { Repo } from '../shared/repo-types'
import { probeGitRemoteIdentity } from './repo-git-remote-identity'

const NO_IDENTITY_RETRY_TTL_MS = 5 * 60 * 1000
// Why 6h: a resolved identity only changes when a remote is added or the project is renamed or
// transferred, so this trades a `git remote -v` per repo per quarter-day for identity gates that
// stop being frozen for the life of the repo record.
const RESOLVED_IDENTITY_REFRESH_TTL_MS = 6 * 60 * 60 * 1000
// Why: the deadline map is per-process, so a restart would otherwise make every resolved repo due
// at once, on the first list call — the worst moment to spawn a subprocess per repo.
const RESOLVED_IDENTITY_REFRESH_STARTUP_DELAY_MS = 5 * 60 * 1000
// Why: refreshes are speculative, so a large repo list drains across sweeps instead of stalling one
// list call behind N sequential probes (each an SSH round trip for off-host repos).
const MAX_IDENTITY_REFRESHES_PER_SWEEP = 4

type RepoIdentityStore = {
  getRepos(): Repo[]
  getRepo?(id: string): Repo | undefined
  updateRepo(id: string, updates: Pick<Partial<Repo>, 'gitRemoteIdentity'>): Repo | null
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
// Why a set rather than the current caller's callback: coalesced sweeps come from different call
// sites (the list IPC handlers and the runtime RPC, which also drops a resolved-worktree cache), so
// the pass that lands a change has to notify every caller still waiting on it. Callers MUST pass a
// stable callback reference — the set dedupes by function identity, so a fresh closure per call
// would grow it (and multiply the broadcast) for the length of a sweep chain that never quiesces.
const pendingChangeListeners = new Set<() => void>()
let sweepInFlight: Promise<void> | null = null
let rerunRequested = false

// Keyed on the resolved host, not the raw field: two rows at the same path on different hosts are
// different locations, and collapsing them shares one probe (and one abort) across both.
function getRepoLocationKey(repo: Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>): string {
  return `${getRepoExecutionHostId(repo)}\0${repo.path}`
}

/**
 * The host *this* process may run the probe on. `getSshTargetIdForExecutionHost`, not the row's
 * file-holding target: a `runtime:` row's nested SSH target lives in that server's namespace, so
 * dialing it here would reach a same-named box of ours — a wrong-host answer, not a local one.
 */
function getRepoProbeHostId(repo: Repo): ExecutionHostId {
  const hostId = getRepoExecutionHostId(repo)
  return getSshTargetIdForExecutionHost(hostId) ? hostId : LOCAL_EXECUTION_HOST_ID
}

function getCurrentRepo(store: RepoIdentityStore, id: string): Repo | undefined {
  return store.getRepo?.(id) ?? store.getRepos().find((repo) => repo.id === id)
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
    // Why: the no-remote marker is re-derived on every retry; skip the redundant
    // write so repo-list consumers do not churn.
    return !(probed === null && existing === null)
  }
  // Why: a resolved identity is replaced only by a probe that found a genuinely different repo.
  // Failures and no-remote answers must never clear it — consumers read an absent identity as
  // "unknown" and gate permissively, so losing one is worse than carrying a stale one.
  return !!probed && probed.canonicalKey !== existing.canonicalKey
}

function writeIdentity(
  store: RepoIdentityStore,
  snapshot: Repo,
  gitRemoteIdentity: Repo['gitRemoteIdentity']
): boolean {
  const current = getCurrentRepo(store, snapshot.id)
  if (
    !isSameProbedRepo(snapshot, current) ||
    !shouldWriteProbedIdentity(current, gitRemoteIdentity)
  ) {
    return false
  }
  return !!store.updateRepo(snapshot.id, { gitRemoteIdentity })
}

async function enrichRepoGitRemoteIdentity(store: RepoIdentityStore, repo: Repo): Promise<boolean> {
  const locationKey = getRepoLocationKey(repo)
  const retryAfter = probeRetryAfterByLocation.get(locationKey) ?? 0
  if (retryAfter > Date.now()) {
    return false
  }
  const inFlight = inFlightProbesByLocation.get(locationKey)
  if (inFlight) {
    return inFlight.promise
  }
  // Why: a failed refresh of an already-resolved repo backs off on the long TTL — an SSH host that
  // is down for the day must not re-probe every five minutes for an identity we already hold.
  const missTtlMs = repo.gitRemoteIdentity
    ? RESOLVED_IDENTITY_REFRESH_TTL_MS
    : NO_IDENTITY_RETRY_TTL_MS
  const controller = new AbortController()
  const promise = (async () => {
    const result = await probeGitRemoteIdentity(repo.path, getRepoProbeHostId(repo), {
      signal: controller.signal
    })
    // Why the signal and not a catch: probeGitRemoteIdentity swallows the AbortError and RESOLVES
    // `unavailable`, so a retired probe would otherwise re-seed a deadline for a location that no
    // longer has a repo. Do not simplify this into a rejection path.
    if (controller.signal.aborted) {
      return false
    }
    if (result.status !== 'resolved') {
      // Why: repos without a parseable remote are common; cache misses briefly so
      // list calls stay cheap while still allowing recent remote changes to land.
      probeRetryAfterByLocation.set(locationKey, Date.now() + missTtlMs)
      // Why: only a probe that actually reached git settles "no usable remote".
      // An unreachable host leaves the identity unknown so consumers can keep
      // treating the repo as pending instead of ineligible.
      return result.status === 'no-remote' ? writeIdentity(store, repo, null) : false
    }

    probeRetryAfterByLocation.set(locationKey, Date.now() + RESOLVED_IDENTITY_REFRESH_TTL_MS)
    return writeIdentity(store, repo, result.identity)
  })().finally(() => {
    // Why compare the controller: retirement may already have replaced this location's entry, and
    // only the probe that owns the current one may clear it.
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

/**
 * Drop deadlines and abort probes for locations no longer backed by a repo, so removed repos and
 * retired SSH hosts do not accumulate — or keep a git child alive — for the life of the process.
 */
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
    // Why drop it here rather than leave it to the probe's own `.finally`: a probe that never
    // settles would keep both the entry and its child alive, and re-poison this location if the
    // same repo is added back.
    if (!liveKeys.has(locationKey)) {
      entry.controller.abort()
      inFlightProbesByLocation.delete(locationKey)
    }
  }
}

function selectEnrichmentCandidates(store: RepoIdentityStore): Repo[] {
  const now = Date.now()
  const repos = store.getRepos().filter((repo) => repo.kind !== 'folder')
  // Why: the settled `null` marker stays a candidate on purpose — a repo that
  // gains a remote later must still resolve. Do not tighten this to
  // `=== undefined`; the retry TTL already bounds the cost and `writeIdentity`
  // skips the redundant rewrite.
  const candidates = repos.filter((repo) => !repo.gitRemoteIdentity)
  // Why re-probe at all: an identity resolved once is otherwise frozen for the life of the repo
  // record, so a later `git remote add upstream` or a project rename/transfer keeps misjudging
  // identity gates against the path the repo had when it was added.
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
    // Why: enrichment runs later; capture the location we probed so a mutable
    // store cannot make the stale-write guard compare against changed fields.
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
  // Why outside the in-flight guard: retirement is exactly what a stuck sweep needs, and
  // `getRepos()` builds its list synchronously from in-memory state, so a repo is never
  // transiently absent and cannot lose its startup delay or backoff. The try/catch keeps the
  // no-throw contract this fire-and-forget entry point had when retirement ran inside the pass.
  try {
    retireRemovedLocations(store.getRepos())
  } catch (error: unknown) {
    console.error('[repo-identity] Failed to retire removed repo locations:', error)
  }
  if (options.onChanged) {
    pendingChangeListeners.add(options.onChanged)
  }
  if (sweepInFlight) {
    // Why: the sweep probes candidates sequentially, so one fresh pass per list IPC piles up behind
    // a slow probe — queue a single follow-up instead, which still picks up repos added mid-pass.
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
        // Why clear only once the chain quiesces: dropping listeners earlier would leave a
        // coalesced caller unnotified by the follow-up pass its own call queued.
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
