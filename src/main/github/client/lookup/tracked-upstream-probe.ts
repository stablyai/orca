import {
  createGitReviewBranchSourceResolver,
  type GitReviewBranchSourceResolver
} from '../../../../shared/git/remotes/git-review-branch-source'
import { gitExecFileAsync } from '../../../git/command-runner/git-exec-file'
import type { GitExecOptions } from '../../../git/command-runner/git-exec-options'
import type { GitAdmissionTier } from '../../../../shared/rpc-contract/source-control/git-admission-tier-params'
import { requireReachableGitRoute } from '../../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host/execution-host'
import {
  TRACKED_UPSTREAM_SNAPSHOT_CACHE_TTL_MS,
  getTrackedUpstreamRoute,
  parseRawTrackedUpstreamBranches,
  readTrackedUpstreamConfigSignature,
  type TrackedUpstreamBranch,
  type TrackedUpstreamRoute,
  type TrackedUpstreamSnapshotProbeResult
} from './tracked-upstream-cache'

export type TrackedUpstreamLocalGitOptions = {
  wslDistro?: string
  admissionTier?: GitAdmissionTier
}

const EMPTY_UPSTREAMS_MAP = new Map<string, TrackedUpstreamBranch | null>()

export const TRACKED_UPSTREAM_ROUTE_CHANGED: TrackedUpstreamSnapshotProbeResult = {
  expiresAt: 0,
  cacheable: false,
  coherent: false,
  probeFailed: true,
  upstreamsByBranchName: EMPTY_UPSTREAMS_MAP
}

export async function probeTrackedUpstreamSnapshot(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: TrackedUpstreamLocalGitOptions = {},
  reviewBranchName?: string,
  route: TrackedUpstreamRoute = getTrackedUpstreamRoute(repoPath, connectionId, localGitOptions)
): Promise<TrackedUpstreamSnapshotProbeResult> {
  let routeChanged = false
  const observeGitRuntime = (runsIn: string): void => {
    routeChanged ||= runsIn !== route.runsIn
  }
  const routeIsCurrent = (): boolean => {
    if (!routeChanged) {
      observeGitRuntime(getTrackedUpstreamRoute(repoPath, connectionId, localGitOptions).runsIn)
    }
    return !routeChanged
  }
  const startingGitConfigSignature = await readTrackedUpstreamConfigSignature(repoPath, route)
  if (!routeIsCurrent()) {
    return TRACKED_UPSTREAM_ROUTE_CHANGED
  }
  const gitOptions = {
    ...localGitOptions,
    observeGitRuntime,
    ...(process.platform === 'win32' ? { canStart: () => !routeChanged } : {})
  }
  let { probeFailed, rawUpstreamsByBranchName } = await probeRawTrackedUpstreamBranches(
    repoPath,
    connectionId,
    gitOptions
  )
  let reviewSourceResolver: GitReviewBranchSourceResolver | undefined
  if (reviewBranchName && !probeFailed && !routeChanged) {
    try {
      requireReachableGitRoute(getConnectionExecutionHostId(connectionId))
      if (!rawUpstreamsByBranchName.has(reviewBranchName)) {
        rawUpstreamsByBranchName.set(reviewBranchName, '')
      }
      reviewSourceResolver = await createGitReviewBranchSourceResolver((args) => {
        if (!routeIsCurrent()) {
          throw new Error('Git runtime changed during the review snapshot')
        }
        return gitExecFileAsync(args, { cwd: repoPath, ...gitOptions })
      })
    } catch {
      probeFailed = true
    }
  }
  const endingGitConfigSignature = routeIsCurrent()
    ? await readTrackedUpstreamConfigSignature(repoPath, route)
    : undefined
  const torn = startingGitConfigSignature !== endingGitConfigSignature
  const coherent = routeIsCurrent() && !torn
  return {
    // Joined callers and the published entry share the deadline from probe completion.
    expiresAt: Date.now() + TRACKED_UPSTREAM_SNAPSHOT_CACHE_TTL_MS,
    // Do not cache failed or incoherent snapshots; later lookups must be able to retry.
    cacheable: coherent && !probeFailed,
    coherent,
    probeFailed,
    ...(!torn && endingGitConfigSignature ? { gitConfigSignature: endingGitConfigSignature } : {}),
    upstreamsByBranchName: EMPTY_UPSTREAMS_MAP,
    rawUpstreamsByBranchName,
    ...(reviewSourceResolver ? { reviewSourceResolver } : {})
  }
}

export async function probeRawTrackedUpstreamBranches(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: TrackedUpstreamLocalGitOptions &
    Pick<GitExecOptions, 'observeGitRuntime' | 'canStart'> = {}
): Promise<{
  probeFailed: boolean
  rawUpstreamsByBranchName: Map<string, string>
}> {
  const args = ['for-each-ref', '--format=%(refname)%00%(upstream)', 'refs/heads']
  requireReachableGitRoute(getConnectionExecutionHostId(connectionId))
  try {
    const result = await gitExecFileAsync(args, { cwd: repoPath, ...localGitOptions })
    return {
      probeFailed: false,
      rawUpstreamsByBranchName: parseRawTrackedUpstreamBranches(result.stdout)
    }
  } catch {
    return { probeFailed: true, rawUpstreamsByBranchName: new Map() }
  }
}
