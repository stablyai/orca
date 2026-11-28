import type {
  GitReviewBranchSource,
  GitReviewBranchSourceResolver
} from '../../../../shared/git/remotes/git-review-branch-source'
import { splitRemoteBranchName } from '../../../../shared/git/remotes/git-remote-branch-name'
import type { GitHubRepositoryIdentity as OwnerRepo } from '../../../../shared/github/repositories/repository-identity'
import { readLocalGitConfigSignature } from '../../repositories/local-git-config-signature'
import { githubRepoIdentityKey } from '../../../../shared/github/repositories/repository-identity-key'
import { predictLocalGitRunsIn } from '../../../git/command-runner/host-routing/git-runs-in'
import { stripWin32LongPathPrefix } from '../../../../shared/file-access/windows-path-access'
export type TrackedUpstreamBranch = {
  remoteName: string
  branchName: string
}

export const TRACKED_UPSTREAM_SNAPSHOT_CACHE_TTL_MS = 30_000

// Keyed per worktree route: linked worktrees can differ in effective config (config.worktree, onbranch includes).
export const TRACKED_UPSTREAM_SNAPSHOT_CACHE_MAX_ENTRIES = 512

export type TrackedUpstreamSnapshotCacheEntry = {
  expiresAt: number
  gitConfigSignature?: string
  /** Publication order; a superseded probe may only adopt an entry published after it started. */
  publishedSeq: number
  upstreamsByBranchName: Map<string, TrackedUpstreamBranch | null>
  /** Raw %(upstream) refs keyed by local branch name; parsed lazily on lookup to avoid allocating thousands of objects per repo. */
  rawUpstreamsByBranchName?: Map<string, string>
  reviewSources?: Map<string, GitReviewBranchSource | Error>
  reviewSourceResolver?: GitReviewBranchSourceResolver
}

export type TrackedUpstreamSnapshotProbeResult = {
  expiresAt: number
  cacheable: boolean
  /** False when config or the Git route changed during the probe: its commands may disagree. */
  coherent: boolean
  gitConfigSignature?: string
  probeFailed: boolean
  upstreamsByBranchName: Map<string, TrackedUpstreamBranch | null>
  rawUpstreamsByBranchName?: Map<string, string>
  reviewSources?: Map<string, GitReviewBranchSource | Error>
  reviewSourceResolver?: GitReviewBranchSourceResolver
}

export const trackedUpstreamSnapshotCache = new Map<string, TrackedUpstreamSnapshotCacheEntry>()

export const trackedUpstreamSnapshotInFlight = new Map<
  string,
  Promise<TrackedUpstreamSnapshotProbeResult>
>()

export const trackedUpstreamSnapshotGenerations = new Map<string, symbol>()

let trackedUpstreamSnapshotPublishSeq = 0

export function currentTrackedUpstreamSnapshotPublishSeq(): number {
  return trackedUpstreamSnapshotPublishSeq
}

export function publishTrackedUpstreamSnapshot(
  cacheKey: string,
  entry: Omit<TrackedUpstreamSnapshotCacheEntry, 'publishedSeq'>
): void {
  // Re-insert so Map order is publication order, which the FIFO bound below relies on.
  trackedUpstreamSnapshotCache.delete(cacheKey)
  trackedUpstreamSnapshotCache.set(cacheKey, {
    ...entry,
    publishedSeq: ++trackedUpstreamSnapshotPublishSeq
  })
  pruneTrackedUpstreamSnapshotCache(Date.now())
}

/** Drop only the entry the caller judged stale; another probe may have replaced it meanwhile. */
export function deleteTrackedUpstreamSnapshot(
  cacheKey: string,
  entry: TrackedUpstreamSnapshotCacheEntry
): void {
  if (trackedUpstreamSnapshotCache.get(cacheKey) === entry) {
    trackedUpstreamSnapshotCache.delete(cacheKey)
  }
}

export function beginTrackedUpstreamSnapshotProbe(cacheKey: string): symbol {
  const generation = Symbol()
  trackedUpstreamSnapshotGenerations.set(cacheKey, generation)
  return generation
}

export function finishTrackedUpstreamSnapshotProbe(cacheKey: string, generation: symbol): void {
  // Generation guards matter only for active probes; completed keys must not leak identities.
  if (trackedUpstreamSnapshotGenerations.get(cacheKey) === generation) {
    trackedUpstreamSnapshotGenerations.delete(cacheKey)
  }
}

export function pruneTrackedUpstreamSnapshotCache(now: number): void {
  for (const [cacheKey, cached] of trackedUpstreamSnapshotCache) {
    if (cached.expiresAt <= now) {
      trackedUpstreamSnapshotCache.delete(cacheKey)
    }
  }
  // Workspace/runtime churn can exceed a memory budget before any TTL expires.
  while (trackedUpstreamSnapshotCache.size > TRACKED_UPSTREAM_SNAPSHOT_CACHE_MAX_ENTRIES) {
    const oldestKey = trackedUpstreamSnapshotCache.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    trackedUpstreamSnapshotCache.delete(oldestKey)
  }
}

export function parseTrackedUpstreamBranch(upstreamRef: string): TrackedUpstreamBranch | null {
  const parsed = splitRemoteBranchName(upstreamRef.trim())
  if (!parsed) {
    return null
  }
  return parsed
}

export function shouldRetryTrackedUpstreamBranch(
  upstreamBranch: TrackedUpstreamBranch,
  branchName: string,
  upstreamHeadRepo: OwnerRepo,
  headRepo: OwnerRepo | null
): boolean {
  if (upstreamBranch.branchName !== branchName) {
    return true
  }
  if (!headRepo) {
    return true
  }
  return githubRepoIdentityKey(upstreamHeadRepo) !== githubRepoIdentityKey(headRepo)
}

export function getCacheableTrackedUpstreamSnapshot(
  upstreamsByBranchName: Map<string, TrackedUpstreamBranch | null>
): Map<string, TrackedUpstreamBranch | null> {
  // Remote config cannot be inspected cheaply here; short TTL bounds stale results.
  return upstreamsByBranchName
}

export function canUseCachedTrackedUpstreamBranch(
  cached: TrackedUpstreamSnapshotCacheEntry,
  branchName: string
): boolean {
  return (
    cached.rawUpstreamsByBranchName?.has(branchName) === true ||
    cached.upstreamsByBranchName.has(branchName)
  )
}

export type TrackedUpstreamRoute = {
  cacheKey: string
  /** `ssh:<id>`, `host` or `wsl:<distro>`: the Git that runs this worktree's commands. */
  runsIn: string
  /** Host filesystem signatures describe only host Git on a host path; UNC and WSL rely on TTL. */
  signed: boolean
}

/** Effective config is per worktree and per Git runtime, so both name the entry. */
export function getTrackedUpstreamRoute(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: { wslDistro?: string } = {}
): TrackedUpstreamRoute {
  const runsIn = connectionId
    ? `ssh:${connectionId}`
    : predictLocalGitRunsIn(repoPath, localGitOptions.wslDistro)
  const unc = process.platform === 'win32' && /^[\\/]{2}/.test(stripWin32LongPathPrefix(repoPath))
  return {
    cacheKey: [runsIn, repoPath].join('\0'),
    runsIn,
    signed: runsIn === 'host' && !unc
  }
}

export function readTrackedUpstreamConfigSignature(
  repoPath: string,
  route: TrackedUpstreamRoute
): Promise<string | undefined> {
  return route.signed
    ? readLocalGitConfigSignature({ repoPath, connectionId: null })
    : Promise.resolve(undefined)
}

/** Signatures cover the caller's own common config, config.worktree, includes and onbranch HEAD. */
export async function doesTrackedUpstreamCacheConfigSignatureMatch(
  cached: Pick<TrackedUpstreamSnapshotCacheEntry, 'gitConfigSignature'>,
  repoPath: string,
  route: TrackedUpstreamRoute,
  allowUnsignedHit = false
): Promise<boolean> {
  if (!route.signed) {
    return true
  }
  if (!cached.gitConfigSignature) {
    return allowUnsignedHit
  }
  return (await readTrackedUpstreamConfigSignature(repoPath, route)) === cached.gitConfigSignature
}

export function parseRawTrackedUpstreamBranches(stdout: string): Map<string, string> {
  const rawByBranchName = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      continue
    }
    const sep = line.indexOf('\0')
    const rawBranch = sep === -1 ? line : line.slice(0, sep)
    const localBranchName = rawBranch.startsWith('refs/heads/')
      ? rawBranch.slice('refs/heads/'.length)
      : rawBranch
    if (!localBranchName) {
      continue
    }
    rawByBranchName.set(localBranchName, sep === -1 ? '' : line.slice(sep + 1))
  }
  return rawByBranchName
}
