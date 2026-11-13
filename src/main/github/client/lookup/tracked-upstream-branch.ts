import {
  readGitReviewBranchSources,
  type GitReviewBranchSource
} from '../../../../shared/git/remotes/git-review-branch-source'
import { gitExecFileAsync } from '../../../git/command-runner/git-exec-file'
import { readLocalGitConfigSignature } from '../../repositories/local-git-config-signature'
import type { GitAdmissionTier } from '../../../../shared/rpc-contract/source-control/git-admission-tier-params'
import {
  TRACKED_UPSTREAM_SNAPSHOT_CACHE_TTL_MS,
  trackedUpstreamSnapshotCache,
  trackedUpstreamSnapshotInFlight,
  trackedUpstreamSnapshotGenerations,
  beginTrackedUpstreamSnapshotProbe,
  finishTrackedUpstreamSnapshotProbe,
  pruneTrackedUpstreamSnapshotCache,
  parseTrackedUpstreamBranch,
  getCacheableTrackedUpstreamSnapshot,
  doesTrackedUpstreamCacheConfigSignatureMatch,
  getTrackedUpstreamBranchCacheKey,
  type TrackedUpstreamBranch,
  type TrackedUpstreamSnapshotProbeResult
} from './tracked-upstream-cache'
import { requireReachableGitRoute } from '../../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host'
export async function getTrackedUpstreamBranch(
  repoPath: string,
  branchName: string,
  connectionId?: string | null,
  localGitOptions: { wslDistro?: string; admissionTier?: GitAdmissionTier } = {}
): Promise<TrackedUpstreamBranch | null> {
  const snapshot = await getTrackedUpstreamSnapshot(
    repoPath,
    branchName,
    connectionId,
    localGitOptions
  )
  return snapshot.upstreamsByBranchName.get(branchName) ?? null
}

export async function getReviewBranchSource(
  repoPath: string,
  branchName: string,
  connectionId?: string | null,
  localGitOptions: { wslDistro?: string; admissionTier?: GitAdmissionTier } = {},
  force = false
): Promise<GitReviewBranchSource> {
  const snapshot = await getTrackedUpstreamSnapshot(
    repoPath,
    branchName,
    connectionId,
    localGitOptions,
    true,
    force
  )
  const source = snapshot.reviewSources?.get(branchName)
  if (snapshot.probeFailed || !source || source instanceof Error) {
    throw new Error('Cannot establish the branch review source')
  }
  return source
}

async function getTrackedUpstreamSnapshot(
  repoPath: string,
  branchName: string,
  connectionId?: string | null,
  localGitOptions: { wslDistro?: string; admissionTier?: GitAdmissionTier } = {},
  includeReviewSources = false,
  force = false
): Promise<TrackedUpstreamSnapshotProbeResult> {
  const cacheKey = getTrackedUpstreamBranchCacheKey(repoPath, connectionId, localGitOptions)
  const serves = (
    value: Pick<TrackedUpstreamSnapshotProbeResult, 'upstreamsByBranchName' | 'reviewSources'>
  ): boolean =>
    value.upstreamsByBranchName.has(branchName) &&
    (!includeReviewSources || value.reviewSources?.has(branchName) === true)
  const cached = trackedUpstreamSnapshotCache.get(cacheKey)
  if (
    cached &&
    !force &&
    cached.expiresAt > Date.now() &&
    serves(cached) &&
    (await doesTrackedUpstreamCacheConfigSignatureMatch(
      cached,
      repoPath,
      connectionId,
      localGitOptions
    ))
  ) {
    return { ...cached, cacheable: true, probeFailed: false }
  }
  if (cached) {
    trackedUpstreamSnapshotCache.delete(cacheKey)
  }
  const inFlight = trackedUpstreamSnapshotInFlight.get(cacheKey)
  if (inFlight && !force) {
    const result = await inFlight
    if (serves(result)) {
      return result
    }
    const retry = trackedUpstreamSnapshotInFlight.get(cacheKey)
    if (retry && retry !== inFlight) {
      const fresh = await retry
      if (serves(fresh)) {
        return fresh
      }
    }
  }
  const generation = beginTrackedUpstreamSnapshotProbe(cacheKey)
  const probe = probeTrackedUpstreamSnapshot(
    repoPath,
    connectionId,
    localGitOptions,
    includeReviewSources ? branchName : undefined
  )
  trackedUpstreamSnapshotInFlight.set(cacheKey, probe)
  try {
    const result = await probe
    if (result.cacheable && trackedUpstreamSnapshotGenerations.get(cacheKey) === generation) {
      trackedUpstreamSnapshotCache.set(cacheKey, {
        ...(result.gitConfigSignature ? { gitConfigSignature: result.gitConfigSignature } : {}),
        upstreamsByBranchName: getCacheableTrackedUpstreamSnapshot(result.upstreamsByBranchName),
        ...(result.reviewSources ? { reviewSources: result.reviewSources } : {}),
        expiresAt: Date.now() + TRACKED_UPSTREAM_SNAPSHOT_CACHE_TTL_MS
      })
      pruneTrackedUpstreamSnapshotCache(Date.now())
    }
    if (trackedUpstreamSnapshotGenerations.get(cacheKey) !== generation) {
      const fresh = trackedUpstreamSnapshotCache.get(cacheKey)
      if (fresh && serves(fresh)) {
        return { ...fresh, cacheable: true, probeFailed: false }
      }
    }
    return result
  } finally {
    if (trackedUpstreamSnapshotInFlight.get(cacheKey) === probe) {
      trackedUpstreamSnapshotInFlight.delete(cacheKey)
    }
    finishTrackedUpstreamSnapshotProbe(cacheKey, generation)
  }
}

export async function probeTrackedUpstreamSnapshot(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: { wslDistro?: string; admissionTier?: GitAdmissionTier } = {},
  reviewBranchName?: string
): Promise<TrackedUpstreamSnapshotProbeResult> {
  const startingGitConfigSignature = await readLocalGitConfigSignature({
    repoPath,
    connectionId: connectionId ?? null,
    ...localGitOptions
  })
  let { probeFailed, upstreamsByBranchName } = await probeTrackedUpstreamBranches(
    repoPath,
    connectionId,
    localGitOptions
  )
  let reviewSources: Map<string, GitReviewBranchSource | Error> | undefined
  if (reviewBranchName && !probeFailed) {
    try {
      requireReachableGitRoute(getConnectionExecutionHostId(connectionId))
      if (!upstreamsByBranchName.has(reviewBranchName)) {
        upstreamsByBranchName.set(reviewBranchName, null)
      }
      reviewSources = await readGitReviewBranchSources(
        (args) => gitExecFileAsync(args, { cwd: repoPath, ...localGitOptions }),
        upstreamsByBranchName.keys()
      )
    } catch {
      probeFailed = true
    }
  }
  const endingGitConfigSignature = await readLocalGitConfigSignature({
    repoPath,
    connectionId: connectionId ?? null,
    ...localGitOptions
  })
  const isLocalHostRuntime = !connectionId && !localGitOptions.wslDistro
  const configSignatureChanged =
    isLocalHostRuntime && startingGitConfigSignature !== endingGitConfigSignature
  const gitConfigSignature =
    startingGitConfigSignature === endingGitConfigSignature ? endingGitConfigSignature : undefined
  return {
    // Do not cache failed snapshots; later lookups must be able to retry.
    cacheable: !configSignatureChanged && !probeFailed,
    probeFailed,
    ...(gitConfigSignature ? { gitConfigSignature } : {}),
    upstreamsByBranchName,
    ...(reviewSources ? { reviewSources } : {})
  }
}

export async function probeTrackedUpstreamBranches(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: { wslDistro?: string; admissionTier?: GitAdmissionTier } = {}
): Promise<{
  probeFailed: boolean
  upstreamsByBranchName: Map<string, TrackedUpstreamBranch | null>
}> {
  const args = ['for-each-ref', '--format=%(refname)%00%(upstream)', 'refs/heads']
  requireReachableGitRoute(getConnectionExecutionHostId(connectionId))
  try {
    const result = await gitExecFileAsync(args, {
      cwd: repoPath,
      ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
      ...(localGitOptions.admissionTier ? { admissionTier: localGitOptions.admissionTier } : {})
    })
    return {
      probeFailed: false,
      upstreamsByBranchName: parseTrackedUpstreamBranches(result.stdout)
    }
  } catch {
    return { probeFailed: true, upstreamsByBranchName: new Map() }
  }
}

export function parseTrackedUpstreamBranches(
  stdout: string
): Map<string, TrackedUpstreamBranch | null> {
  const upstreamsByBranchName = new Map<string, TrackedUpstreamBranch | null>()
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      continue
    }
    const [branchName, upstreamRef] = line.split('\0')
    const localBranchName = branchName?.replace(/^refs\/heads\//, '')
    if (!localBranchName) {
      continue
    }
    upstreamsByBranchName.set(localBranchName, parseTrackedUpstreamRef(upstreamRef ?? ''))
  }
  return upstreamsByBranchName
}

export function parseTrackedUpstreamRef(upstreamRef: string): TrackedUpstreamBranch | null {
  const remoteRefPrefix = 'refs/remotes/'
  const normalizedRef = upstreamRef.trim()
  if (normalizedRef.startsWith(remoteRefPrefix)) {
    return parseTrackedUpstreamBranch(normalizedRef.slice(remoteRefPrefix.length))
  }
  if (normalizedRef.startsWith('refs/heads/')) {
    return null
  }
  return parseTrackedUpstreamBranch(normalizedRef)
}
