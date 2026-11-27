import type { GitReviewBranchSource } from '../../../../shared/git/remotes/git-review-branch-source'
import {
  TRACKED_UPSTREAM_SNAPSHOT_CACHE_TTL_MS,
  trackedUpstreamSnapshotCache,
  trackedUpstreamSnapshotInFlight,
  trackedUpstreamSnapshotGenerations,
  beginTrackedUpstreamSnapshotProbe,
  finishTrackedUpstreamSnapshotProbe,
  currentTrackedUpstreamSnapshotPublishSeq,
  publishTrackedUpstreamSnapshot,
  deleteTrackedUpstreamSnapshot,
  parseTrackedUpstreamBranch,
  getCacheableTrackedUpstreamSnapshot,
  doesTrackedUpstreamCacheConfigSignatureMatch,
  getTrackedUpstreamRoute,
  type TrackedUpstreamBranch,
  type TrackedUpstreamSnapshotCacheEntry,
  type TrackedUpstreamSnapshotProbeResult
} from './tracked-upstream-cache'
import {
  probeRawTrackedUpstreamBranches,
  probeTrackedUpstreamSnapshot,
  type TrackedUpstreamLocalGitOptions
} from './tracked-upstream-probe'

export async function getTrackedUpstreamBranch(
  repoPath: string,
  branchName: string,
  connectionId?: string | null,
  localGitOptions: TrackedUpstreamLocalGitOptions = {},
  force = false
): Promise<TrackedUpstreamBranch | null> {
  const snapshot = await getTrackedUpstreamSnapshot(
    repoPath,
    branchName,
    connectionId,
    localGitOptions,
    false,
    force
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
  localGitOptions: TrackedUpstreamLocalGitOptions = {},
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
  connectionId: string | null | undefined,
  localGitOptions: TrackedUpstreamLocalGitOptions,
  includeReviewSources: boolean,
  force: boolean
): Promise<TrackedUpstreamSnapshotProbeResult> {
  const args = [
    repoPath,
    branchName,
    connectionId,
    localGitOptions,
    includeReviewSources,
    force
  ] as const
  const first = await lookupTrackedUpstreamSnapshot(...args)
  if (first.coherent) {
    return first
  }
  // A probe that saw config or its Git route change may mix both sides; one fresh attempt is usually coherent.
  const second = await lookupTrackedUpstreamSnapshot(...args)
  return second.coherent ? second : { ...second, probeFailed: true }
}

function snapshotFromEntry(
  entry: TrackedUpstreamSnapshotCacheEntry
): TrackedUpstreamSnapshotProbeResult {
  return { ...entry, cacheable: true, coherent: true, probeFailed: false }
}

async function lookupTrackedUpstreamSnapshot(
  repoPath: string,
  branchName: string,
  connectionId: string | null | undefined,
  localGitOptions: TrackedUpstreamLocalGitOptions,
  includeReviewSources: boolean,
  force: boolean
): Promise<TrackedUpstreamSnapshotProbeResult> {
  const route = getTrackedUpstreamRoute(repoPath, connectionId, localGitOptions)
  const { cacheKey } = route
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
  const validate = async (
    value: Pick<TrackedUpstreamSnapshotProbeResult, 'gitConfigSignature'>,
    allowUnsignedHit = false
  ): Promise<boolean> =>
    (await doesTrackedUpstreamCacheConfigSignatureMatch(
      value,
      repoPath,
      route,
      allowUnsignedHit
    )) && getTrackedUpstreamRoute(repoPath, connectionId, localGitOptions).runsIn === route.runsIn
  const acceptsJoined = async (result: TrackedUpstreamSnapshotProbeResult): Promise<boolean> =>
    result.cacheable && serves(result) && (await validate(result))

  const cached = trackedUpstreamSnapshotCache.get(cacheKey)
  if (cached) {
    const unexpired = !force && cached.expiresAt > Date.now()
    if (unexpired && serves(cached)) {
      if ((await validate(cached, true)) && cached.expiresAt > Date.now()) {
        return snapshotFromEntry(cached)
      }
      deleteTrackedUpstreamSnapshot(cacheKey, cached)
    } else if (!unexpired) {
      deleteTrackedUpstreamSnapshot(cacheKey, cached)
    }
    // A valid entry that lacks this branch or a resolver stays until a successful probe replaces it.
  }
  const inFlight = trackedUpstreamSnapshotInFlight.get(cacheKey)
  if (inFlight && !force) {
    const result = await inFlight
    if (await acceptsJoined(result)) {
      return result
    }
    const retry = trackedUpstreamSnapshotInFlight.get(cacheKey)
    if (retry && retry !== inFlight) {
      const fresh = await retry
      if (await acceptsJoined(fresh)) {
        return fresh
      }
    }
  }
  const generation = beginTrackedUpstreamSnapshotProbe(cacheKey)
  const startSeq = currentTrackedUpstreamSnapshotPublishSeq()
  const probe = probeTrackedUpstreamSnapshot(
    repoPath,
    connectionId,
    localGitOptions,
    includeReviewSources ? branchName : undefined,
    route
  )
  trackedUpstreamSnapshotInFlight.set(cacheKey, probe)
  let result: TrackedUpstreamSnapshotProbeResult
  let superseded: boolean
  try {
    result = await probe
    superseded = trackedUpstreamSnapshotGenerations.get(cacheKey) !== generation
    if (result.cacheable && !superseded) {
      publishTrackedUpstreamSnapshot(cacheKey, {
        ...(result.gitConfigSignature ? { gitConfigSignature: result.gitConfigSignature } : {}),
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
    }
  } finally {
    if (trackedUpstreamSnapshotInFlight.get(cacheKey) === probe) {
      trackedUpstreamSnapshotInFlight.delete(cacheKey)
    }
    finishTrackedUpstreamSnapshotProbe(cacheKey, generation)
  }
  if (superseded) {
    // Only a newer, still-valid publication beats this probe's own answer; an older survivor never does.
    const fresh = trackedUpstreamSnapshotCache.get(cacheKey)
    if (
      fresh &&
      fresh.publishedSeq > startSeq &&
      fresh.expiresAt > Date.now() &&
      serves(fresh) &&
      (await validate(fresh)) &&
      fresh.expiresAt > Date.now()
    ) {
      return snapshotFromEntry(fresh)
    }
  }
  return result
}

export async function probeTrackedUpstreamBranches(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: TrackedUpstreamLocalGitOptions = {}
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
