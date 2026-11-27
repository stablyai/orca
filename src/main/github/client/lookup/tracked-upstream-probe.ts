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
  const startingGitConfigSignature = await readTrackedUpstreamConfigSignature(repoPath, route)
  let { probeFailed, rawUpstreamsByBranchName } = await probeRawTrackedUpstreamBranches(
    repoPath,
    connectionId,
    { ...localGitOptions, observeGitRuntime }
  )
  let reviewSourceResolver: GitReviewBranchSourceResolver | undefined
  if (reviewBranchName && !probeFailed) {
    try {
      requireReachableGitRoute(getConnectionExecutionHostId(connectionId))
      if (!rawUpstreamsByBranchName.has(reviewBranchName)) {
        rawUpstreamsByBranchName.set(reviewBranchName, '')
      }
      reviewSourceResolver = await createGitReviewBranchSourceResolver((args) =>
        gitExecFileAsync(args, { cwd: repoPath, ...localGitOptions, observeGitRuntime })
      )
    } catch {
      probeFailed = true
    }
  }
  const endingGitConfigSignature = await readTrackedUpstreamConfigSignature(repoPath, route)
  observeGitRuntime(getTrackedUpstreamRoute(repoPath, connectionId, localGitOptions).runsIn)
  const torn = startingGitConfigSignature !== endingGitConfigSignature
  const coherent = !torn && !routeChanged
  return {
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
  localGitOptions: TrackedUpstreamLocalGitOptions & Pick<GitExecOptions, 'observeGitRuntime'> = {}
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
