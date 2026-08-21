import { splitRemoteBranchName } from '../../../../shared/git-effective-upstream'
import type { OwnerRepo } from '../../gh-utils'
import { readLocalGitConfigSignature } from '../../local-git-config-signature'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
export type TrackedUpstreamBranch = {
  remoteName: string
  branchName: string
}

export const TRACKED_UPSTREAM_SNAPSHOT_CACHE_TTL_MS = 30_000

export const TRACKED_UPSTREAM_SNAPSHOT_CACHE_MAX_ENTRIES = 512

export type TrackedUpstreamSnapshotCacheEntry = {
  expiresAt: number
  gitConfigSignature?: string
  upstreamsByBranchName: Map<string, TrackedUpstreamBranch | null>
}

export type TrackedUpstreamSnapshotProbeResult = {
  cacheable: boolean
  gitConfigSignature?: string
  probeFailed: boolean
  upstreamsByBranchName: Map<string, TrackedUpstreamBranch | null>
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
  // Why: generations only guard an active probe; retaining completed keys leaks worktree/runtime identities past the snapshot TTL.
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
  // Why: workspace/runtime churn can create unbounded unique keys within one TTL window, so expiry sweeping alone isn't a memory bound.
  while (trackedUpstreamSnapshotCache.size > TRACKED_UPSTREAM_SNAPSHOT_CACHE_MAX_ENTRIES) {
    const oldestKey = trackedUpstreamSnapshotCache.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    trackedUpstreamSnapshotCache.delete(oldestKey)
  }
}

export function _getTrackedUpstreamBranchCacheSizesForTests(): {
  snapshots: number
  inFlight: number
  generations: number
} {
  return {
    snapshots: trackedUpstreamSnapshotCache.size,
    inFlight: trackedUpstreamSnapshotInFlight.size,
    generations: trackedUpstreamSnapshotGenerations.size
  }
}

export function __resetTrackedUpstreamBranchCacheForTests(): void {
  trackedUpstreamSnapshotCache.clear()
  trackedUpstreamSnapshotInFlight.clear()
  trackedUpstreamSnapshotGenerations.clear()
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
  // Why: SSH/WSL can't cheaply inspect remote .git/config here; the short TTL bounds stale positives while refreshes share one scan.
  return upstreamsByBranchName
}

export function canUseCachedTrackedUpstreamBranch(
  cached: TrackedUpstreamSnapshotCacheEntry,
  branchName: string
): boolean {
  return cached.upstreamsByBranchName.has(branchName)
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
    repoPath,
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
