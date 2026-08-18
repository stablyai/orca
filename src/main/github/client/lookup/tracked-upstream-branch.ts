import { gitExecFileAsync } from '../../gh-utils'
import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../../../providers/ssh-git-dispatch'
import { readLocalGitConfigSignature } from '../../local-git-config-signature'
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
  canUseCachedTrackedUpstreamBranch,
  doesTrackedUpstreamCacheConfigSignatureMatch,
  getTrackedUpstreamBranchCacheKey,
  type TrackedUpstreamBranch,
  type TrackedUpstreamSnapshotProbeResult
} from './tracked-upstream-cache'
export async function getTrackedUpstreamBranch(
  repoPath: string,
  branchName: string,
  connectionId?: string | null,
  localGitOptions: { wslDistro?: string } = {}
): Promise<TrackedUpstreamBranch | null> {
  const cacheKey = getTrackedUpstreamBranchCacheKey(repoPath, connectionId, localGitOptions)
  const now = Date.now()
  const cached = trackedUpstreamSnapshotCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    const configSignatureMatches = await doesTrackedUpstreamCacheConfigSignatureMatch(
      cached,
      repoPath,
      connectionId,
      localGitOptions
    )
    if (
      configSignatureMatches &&
      cached.upstreamsByBranchName.has(branchName) &&
      canUseCachedTrackedUpstreamBranch(cached, branchName)
    ) {
      return cached.upstreamsByBranchName.get(branchName) ?? null
    }
    trackedUpstreamSnapshotCache.delete(cacheKey)
  }
  if (cached) {
    trackedUpstreamSnapshotCache.delete(cacheKey)
  }

  const inFlight = trackedUpstreamSnapshotInFlight.get(cacheKey)
  if (inFlight) {
    const result = await inFlight
    if (result.upstreamsByBranchName.has(branchName)) {
      return result.upstreamsByBranchName.get(branchName) ?? null
    }
    // Why: a concurrent snapshot may finish before this branch exists in git; re-probe instead of returning a synthetic null.
    const retryInFlight = trackedUpstreamSnapshotInFlight.get(cacheKey)
    if (retryInFlight) {
      const retryResult = await retryInFlight
      return retryResult.upstreamsByBranchName.get(branchName) ?? null
    }
  }

  // Why: PR polling asks about hundreds of branches at once; read all upstreams in one git process per repo/runtime, not one probe per branch.
  const probeGeneration = beginTrackedUpstreamSnapshotProbe(cacheKey)
  const probe = probeTrackedUpstreamSnapshot(repoPath, connectionId, localGitOptions)
  trackedUpstreamSnapshotInFlight.set(cacheKey, probe)
  try {
    const result = await probe
    if (result.cacheable && trackedUpstreamSnapshotGenerations.get(cacheKey) === probeGeneration) {
      trackedUpstreamSnapshotCache.set(cacheKey, {
        ...(result.gitConfigSignature ? { gitConfigSignature: result.gitConfigSignature } : {}),
        upstreamsByBranchName: getCacheableTrackedUpstreamSnapshot(result.upstreamsByBranchName),
        expiresAt: Date.now() + TRACKED_UPSTREAM_SNAPSHOT_CACHE_TTL_MS
      })
      pruneTrackedUpstreamSnapshotCache(Date.now())
    }
    if (trackedUpstreamSnapshotGenerations.get(cacheKey) !== probeGeneration) {
      const fresherCached = trackedUpstreamSnapshotCache.get(cacheKey)
      if (fresherCached?.upstreamsByBranchName.has(branchName)) {
        return fresherCached.upstreamsByBranchName.get(branchName) ?? null
      }
    }
    return result.upstreamsByBranchName.get(branchName) ?? null
  } finally {
    if (trackedUpstreamSnapshotInFlight.get(cacheKey) === probe) {
      trackedUpstreamSnapshotInFlight.delete(cacheKey)
    }
    finishTrackedUpstreamSnapshotProbe(cacheKey, probeGeneration)
  }
}

export async function probeTrackedUpstreamSnapshot(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: { wslDistro?: string } = {}
): Promise<TrackedUpstreamSnapshotProbeResult> {
  const startingGitConfigSignature = await readLocalGitConfigSignature({
    repoPath,
    connectionId: connectionId ?? null,
    ...localGitOptions
  })
  const { probeFailed, upstreamsByBranchName } = await probeTrackedUpstreamBranches(
    repoPath,
    connectionId,
    localGitOptions
  )
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
    // Why: don't cache an empty snapshot after a transient git failure, or every branch lookup re-probes on the next refresh tick.
    cacheable: !configSignatureChanged && !probeFailed,
    probeFailed,
    ...(gitConfigSignature ? { gitConfigSignature } : {}),
    upstreamsByBranchName
  }
}

export async function probeTrackedUpstreamBranches(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: { wslDistro?: string } = {}
): Promise<{
  probeFailed: boolean
  upstreamsByBranchName: Map<string, TrackedUpstreamBranch | null>
}> {
  const args = ['for-each-ref', '--format=%(refname)%00%(upstream)', 'refs/heads']
  const provider = connectionId ? getSshGitProvider(connectionId) : null
  if (connectionId && !provider) {
    throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
  }
  if (provider) {
    const result = await provider.exec(args, repoPath)
    return {
      probeFailed: false,
      upstreamsByBranchName: parseTrackedUpstreamBranches(result.stdout)
    }
  }
  try {
    const result = await gitExecFileAsync(args, {
      cwd: repoPath,
      ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
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
