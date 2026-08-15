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

const inFlightProbesByLocation = new Map<string, Promise<boolean>>()
const probeRetryAfterByLocation = new Map<string, number>()

function getRepoLocationKey(repo: Pick<Repo, 'path' | 'connectionId'>): string {
  return `${repo.connectionId ?? 'local'}\0${repo.path}`
}

function getCurrentRepo(store: RepoIdentityStore, id: string): Repo | undefined {
  return store.getRepo?.(id) ?? store.getRepos().find((repo) => repo.id === id)
}

function isSameProbedRepo(snapshot: Repo, current: Repo | undefined): current is Repo {
  return (
    !!current &&
    current.kind !== 'folder' &&
    current.path === snapshot.path &&
    (current.connectionId ?? null) === (snapshot.connectionId ?? null)
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
    return inFlight
  }
  // Why: a failed refresh of an already-resolved repo backs off on the long TTL — an SSH host that
  // is down for the day must not re-probe every five minutes for an identity we already hold.
  const missTtlMs = repo.gitRemoteIdentity
    ? RESOLVED_IDENTITY_REFRESH_TTL_MS
    : NO_IDENTITY_RETRY_TTL_MS
  const probe = (async () => {
    const result = await probeGitRemoteIdentity(repo.path, repo.connectionId)
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
    if (inFlightProbesByLocation.get(locationKey) === probe) {
      inFlightProbesByLocation.delete(locationKey)
    }
  })
  inFlightProbesByLocation.set(locationKey, probe)
  return probe
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
 * Drop deadlines for locations no longer backed by a repo, so removed repos and
 * retired SSH hosts do not accumulate for the life of the process.
 */
function pruneRetryDeadlines(liveRepos: Repo[]): void {
  const liveKeys = new Set(liveRepos.map(getRepoLocationKey))
  for (const locationKey of probeRetryAfterByLocation.keys()) {
    // A probe still running for a dropped repo needs no exemption: it re-adds its
    // own deadline on settle, and only live repos are ever candidates, so nothing
    // reads this entry in between.
    if (!liveKeys.has(locationKey)) {
      probeRetryAfterByLocation.delete(locationKey)
    }
  }
}

function selectEnrichmentCandidates(store: RepoIdentityStore): Repo[] {
  const now = Date.now()
  const repos = store.getRepos().filter((repo) => repo.kind !== 'folder')
  // Why here: this is the one place that already enumerates every live repo, and
  // `getRepos()` builds its list synchronously from in-memory state, so a repo is
  // never transiently absent mid-sweep and cannot lose its startup delay or backoff.
  pruneRetryDeadlines(repos)
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
  store: RepoIdentityStore,
  options: EnrichmentOptions
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
  probeRetryAfterByLocation.clear()
}
