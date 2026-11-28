import type {
  GitReviewBranchSource,
  GitReviewBranchSourceResolver
} from '../../../../shared/git/remotes/git-review-branch-source'
import { splitRemoteBranchName } from '../../../../shared/git/remotes/git-remote-branch-name'
import type { GitHubRepositoryIdentity as OwnerRepo } from '../../../../shared/github/repositories/repository-identity'
import { readLocalGitConfigSignature } from '../../repositories/local-git-config-signature'
import { githubRepoIdentityKey } from '../../../../shared/github/repositories/repository-identity-key'
import { getCanonicalRepoKey } from '../../../git/repositories/canonical-repo-key'
export type TrackedUpstreamBranch = {
  remoteName: string
  branchName: string
}

export const TRACKED_UPSTREAM_SNAPSHOT_CACHE_TTL_MS = 30_000

// Keyed per canonical repository (git common dir) rather than per worktree.
export const TRACKED_UPSTREAM_SNAPSHOT_CACHE_MAX_ENTRIES = 64

export type TrackedUpstreamSnapshotCacheEntry = {
  expiresAt: number
  gitConfigSignature?: string
  /** Signatures embed per-worktree config paths; they only compare equal against the worktree that recorded them. */
  gitConfigSignatureRepoPath?: string
  upstreamsByBranchName: Map<string, TrackedUpstreamBranch | null>
  /** Raw %(upstream) refs keyed by local branch name; parsed lazily on lookup to avoid allocating thousands of objects per repo. */
  rawUpstreamsByBranchName?: Map<string, string>
  reviewSources?: Map<string, GitReviewBranchSource | Error>
  reviewSourceResolver?: GitReviewBranchSourceResolver
}

export type TrackedUpstreamSnapshotProbeResult = {
  cacheable: boolean
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

export async function doesTrackedUpstreamCacheConfigSignatureMatch(
  cached: TrackedUpstreamSnapshotCacheEntry,
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: { wslDistro?: string } = {}
): Promise<boolean> {
  if (!cached.gitConfigSignature) {
    return true
  }
  const currentSignature = await readLocalGitConfigSignature({
    repoPath: cached.gitConfigSignatureRepoPath ?? repoPath,
    connectionId: connectionId ?? null,
    ...localGitOptions
  })
  return currentSignature === cached.gitConfigSignature
}

export function getTrackedUpstreamBranchCacheKey(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: { wslDistro?: string } = {}
): string {
  const runtimeKey = connectionId
    ? `ssh:${connectionId}`
    : `local:${localGitOptions.wslDistro ?? 'host'}`
  return [runtimeKey, repoPath].join('\0')
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

export async function resolveTrackedUpstreamBranchCacheKey(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: { wslDistro?: string } = {}
): Promise<string> {
  if (connectionId) {
    return getTrackedUpstreamBranchCacheKey(repoPath, connectionId, localGitOptions)
  }
  return getCanonicalRepoKey(repoPath, localGitOptions)
}
