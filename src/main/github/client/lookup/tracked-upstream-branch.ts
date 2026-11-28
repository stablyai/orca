import type { GitReviewBranchSource } from '../../../../shared/git/remotes/git-review-branch-source'
import {
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
  TRACKED_UPSTREAM_ROUTE_CHANGED,
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
  return second.coherent ? second : failTrackedUpstreamSnapshot(second)
}

function failTrackedUpstreamSnapshot(
  result: TrackedUpstreamSnapshotProbeResult
): TrackedUpstreamSnapshotProbeResult {
  return { ...result, cacheable: false, coherent: false, probeFailed: true }
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
  const routeIsCurrent = () =>
    getTrackedUpstreamRoute(repoPath, connectionId, localGitOptions).runsIn === route.runsIn
  const serves = (
    value: Pick<
      TrackedUpstreamSnapshotProbeResult,
      | 'expiresAt'
      | 'upstreamsByBranchName'
      | 'rawUpstreamsByBranchName'
      | 'reviewSources'
      | 'reviewSourceResolver'
    >
  ): boolean =>
    value.expiresAt > Date.now() &&
    (value.rawUpstreamsByBranchName?.has(branchName) === true ||
      value.upstreamsByBranchName.has(branchName)) &&
    (!includeReviewSources ||
      value.reviewSourceResolver !== undefined ||
      value.reviewSources?.has(branchName) === true)
  const validate = async (
    value: Pick<TrackedUpstreamSnapshotProbeResult, 'expiresAt' | 'gitConfigSignature'>,
    allowUnsignedHit = false
  ): Promise<boolean> =>
    (await doesTrackedUpstreamCacheConfigSignatureMatch(
      value,
      repoPath,
      route,
      allowUnsignedHit
    )) && value.expiresAt > Date.now()
  const join = async (
    probe: Promise<TrackedUpstreamSnapshotProbeResult>
  ): Promise<TrackedUpstreamSnapshotProbeResult | undefined> => {
    const result = await probe
    const valid = result.cacheable && serves(result) && (await validate(result))
    if (!routeIsCurrent()) {
      return TRACKED_UPSTREAM_ROUTE_CHANGED
    }
    return valid ? result : undefined
  }

  // Refresh bypasses the entry for this caller; a usable old snapshot stays until replacement.
  const cached = force ? undefined : trackedUpstreamSnapshotCache.get(cacheKey)
  if (cached) {
    if (serves(cached)) {
      const valid = await validate(cached, true)
      if (!routeIsCurrent()) {
        return TRACKED_UPSTREAM_ROUTE_CHANGED
      }
      if (valid) {
        return snapshotFromEntry(cached)
      }
      deleteTrackedUpstreamSnapshot(cacheKey, cached)
    } else if (cached.expiresAt <= Date.now()) {
      deleteTrackedUpstreamSnapshot(cacheKey, cached)
    }
    // A valid entry that lacks this branch or a resolver stays until a successful probe replaces it.
  }
  const inFlight = force ? undefined : trackedUpstreamSnapshotInFlight.get(cacheKey)
  if (inFlight) {
    const result = await join(inFlight)
    if (result) {
      return result
    }
    const retry = trackedUpstreamSnapshotInFlight.get(cacheKey)
    if (retry && retry !== inFlight) {
      const fresh = await join(retry)
      if (fresh) {
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
    if (!routeIsCurrent()) {
      return failTrackedUpstreamSnapshot(result)
    }
    superseded = trackedUpstreamSnapshotGenerations.get(cacheKey) !== generation
    const now = Date.now()
    if (result.cacheable && !superseded && result.expiresAt > now) {
      const previous =
        force && !includeReviewSources ? trackedUpstreamSnapshotCache.get(cacheKey) : undefined
      if (
        previous?.reviewSourceResolver &&
        previous.expiresAt > now &&
        (!route.signed ||
          (result.gitConfigSignature && previous.gitConfigSignature === result.gitConfigSignature))
      ) {
        // Return fresh refs to the forced caller without displacing a valid review snapshot.
        return result
      }
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
        expiresAt: result.expiresAt
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
    if (fresh && fresh.publishedSeq > startSeq && serves(fresh)) {
      const valid = await validate(fresh)
      if (!routeIsCurrent()) {
        return failTrackedUpstreamSnapshot(result)
      }
      if (valid) {
        return snapshotFromEntry(fresh)
      }
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
