import {
  createGitReviewBranchSourceResolver,
  type GitReviewBranchSource,
  type GitReviewBranchSourceResolver
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
  parseRawTrackedUpstreamBranches,
  resolveTrackedUpstreamBranchCacheKey,
  type TrackedUpstreamBranch,
  type TrackedUpstreamSnapshotProbeResult
} from './tracked-upstream-cache'
import { requireReachableGitRoute } from '../../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host/execution-host'
const EMPTY_UPSTREAMS_MAP = new Map<string, TrackedUpstreamBranch | null>()

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
  if (snapshot.rawUpstreamsByBranchName) {
    const raw = snapshot.rawUpstreamsByBranchName.get(branchName)
    return raw ? parseTrackedUpstreamRef(raw) : null
  }
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
  const source =
    snapshot.reviewSourceResolver?.(branchName) ?? snapshot.reviewSources?.get(branchName)
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
  const cacheKey = await resolveTrackedUpstreamBranchCacheKey(
    repoPath,
    connectionId,
    localGitOptions
  )
  const serves = (
    value: Pick<
      TrackedUpstreamSnapshotProbeResult,
      | 'upstreamsByBranchName'
      | 'rawUpstreamsByBranchName'
      | 'reviewSources'
      | 'reviewSourceResolver'
    >
  ): boolean =>
    (value.rawUpstreamsByBranchName?.has(branchName) === true ||
      value.upstreamsByBranchName.has(branchName)) &&
    (!includeReviewSources ||
      value.reviewSourceResolver !== undefined ||
      value.reviewSources?.has(branchName) === true)
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
        ...(result.gitConfigSignature
          ? { gitConfigSignature: result.gitConfigSignature, gitConfigSignatureRepoPath: repoPath }
          : {}),
        upstreamsByBranchName: getCacheableTrackedUpstreamSnapshot(result.upstreamsByBranchName),
        ...(result.rawUpstreamsByBranchName
          ? { rawUpstreamsByBranchName: result.rawUpstreamsByBranchName }
          : {}),
        ...(result.reviewSources ? { reviewSources: result.reviewSources } : {}),
        ...(result.reviewSourceResolver
          ? { reviewSourceResolver: result.reviewSourceResolver }
          : {}),
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
  let { probeFailed, rawUpstreamsByBranchName } = await probeRawTrackedUpstreamBranches(
    repoPath,
    connectionId,
    localGitOptions
  )
  let reviewSourceResolver: GitReviewBranchSourceResolver | undefined
  if (reviewBranchName && !probeFailed) {
    try {
      requireReachableGitRoute(getConnectionExecutionHostId(connectionId))
      if (!rawUpstreamsByBranchName.has(reviewBranchName)) {
        rawUpstreamsByBranchName.set(reviewBranchName, '')
      }
      reviewSourceResolver = await createGitReviewBranchSourceResolver((args) =>
        gitExecFileAsync(args, { cwd: repoPath, ...localGitOptions })
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
    upstreamsByBranchName: EMPTY_UPSTREAMS_MAP,
    rawUpstreamsByBranchName,
    ...(reviewSourceResolver ? { reviewSourceResolver } : {})
  }
}

async function probeRawTrackedUpstreamBranches(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: { wslDistro?: string; admissionTier?: GitAdmissionTier } = {}
): Promise<{
  probeFailed: boolean
  rawUpstreamsByBranchName: Map<string, string>
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
      rawUpstreamsByBranchName: parseRawTrackedUpstreamBranches(result.stdout)
    }
  } catch {
    return { probeFailed: true, rawUpstreamsByBranchName: new Map() }
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
  const { probeFailed, rawUpstreamsByBranchName } = await probeRawTrackedUpstreamBranches(
    repoPath,
    connectionId,
    localGitOptions
  )
  if (probeFailed) {
    return { probeFailed: true, upstreamsByBranchName: new Map() }
  }
  const upstreamsByBranchName = new Map<string, TrackedUpstreamBranch | null>()
  for (const [branch, raw] of rawUpstreamsByBranchName) {
    upstreamsByBranchName.set(branch, parseTrackedUpstreamRef(raw))
  }
  return { probeFailed: false, upstreamsByBranchName }
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
