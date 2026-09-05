import type { MRInfo } from '../../shared/gitlab-types'
import { derivePipelineStatus, mapMRInfo } from './mappers'
import {
  acquire,
  getGlabKnownHosts,
  getProjectRef,
  glabHostnameArgs,
  glabRepoExecOptions,
  glabExecFileAsync,
  release,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'
import { encodedProject } from './project-path-encoding'
import { countUnresolvedDiscussions, fetchDiscussions } from './mr-discussion-notes'
import {
  hasHostedReviewLocalGitOptions,
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../source-control/hosted-review-git-options'
import { shouldHideNonOpenReviewOnDefaultBranch } from '../source-control/repo-default-branch'

type HostedReviewLocalGitOptions = ReturnType<typeof getHostedReviewLocalGitOptions>

function hostedReviewLocalGitOptionArgs(
  options: HostedReviewExecutionOptions = {}
): [] | [HostedReviewLocalGitOptions] {
  return hasHostedReviewLocalGitOptions(options) ? [getHostedReviewLocalGitOptions(options)] : []
}

export async function getProjectSlug(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<ProjectRef | null> {
  const localGitArgs = hostedReviewLocalGitOptionArgs(options)
  const knownHosts = await getGlabKnownHosts(connectionId, localGitArgs[0])
  return getProjectRef(repoPath, knownHosts, connectionId, ...localGitArgs)
}

type GitLabMRPipelineRaw = Parameters<typeof mapMRInfo>[0] & {
  head_pipeline?: { status?: string } | null
  pipeline?: { status?: string } | null
  user_notes_count?: number
}

/**
 * Attach the unresolved-discussion count for an open MR. `user_notes_count` comes free on the
 * list/detail payload, so the extra `/discussions` call only happens when there is something to count.
 */
async function withUnresolvedCommentCount(
  info: MRInfo,
  raw: GitLabMRPipelineRaw,
  repoPath: string,
  projectRef: ProjectRef | null,
  connectionId: string | null | undefined,
  localGitOptions: LocalGitExecOptions
): Promise<MRInfo> {
  if (!projectRef || raw.state !== 'opened' || typeof raw.user_notes_count !== 'number') {
    return info
  }
  if (raw.user_notes_count === 0) {
    return { ...info, unresolvedReviewCommentCount: 0 }
  }
  try {
    const discussions = await fetchDiscussions(
      repoPath,
      projectRef,
      'mr',
      info.number,
      connectionId,
      localGitOptions
    )
    return { ...info, unresolvedReviewCommentCount: countUnresolvedDiscussions(discussions) }
  } catch {
    return info
  }
}

/**
 * Fetch a single merge request with pipeline status rolled up.
 * Returns null when the MR doesn't exist or glab fails.
 */
export async function getMergeRequest(
  repoPath: string,
  iid: number,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<MRInfo | null> {
  const localGitArgs = hostedReviewLocalGitOptionArgs(options)
  const localGitOptions = localGitArgs[0] ?? {}
  const knownHosts = await getGlabKnownHosts(connectionId, localGitOptions)
  const projectRef = await getProjectRef(repoPath, knownHosts, connectionId, ...localGitArgs)
  await acquire()
  try {
    const args = projectRef
      ? [
          'api',
          ...glabHostnameArgs(projectRef, connectionId),
          `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}`
        ]
      : ['mr', 'view', String(iid), '--output', 'json']
    const { stdout } = await glabExecFileAsync(
      args,
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
    const data = JSON.parse(stdout) as GitLabMRPipelineRaw
    // Why: older GitLab instances expose `pipeline` instead of `head_pipeline`; try both.
    const pipelineStatus = derivePipelineStatus(data.head_pipeline ?? data.pipeline ?? null)
    return withUnresolvedCommentCount(
      mapMRInfo(data, pipelineStatus),
      data,
      repoPath,
      projectRef,
      connectionId,
      localGitOptions
    )
  } catch {
    return null
  } finally {
    release()
  }
}

/**
 * Find the explicitly linked merge request, or the newest MR whose source branch matches.
 * Returns null when neither exists.
 */
export async function getMergeRequestForBranch(
  repoPath: string,
  branch: string,
  linkedMRIid?: number | null,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {},
  // Why: when true, a failed lookup throws instead of returning null, so callers never report a false not_found.
  throwOnFailure = false
): Promise<MRInfo | null> {
  const branchName = branch.replace(/^refs\/heads\//, '')
  if (!branchName && linkedMRIid == null) {
    return null
  }
  const localGitArgs = hostedReviewLocalGitOptionArgs(options)
  const localGitOptions = localGitArgs[0] ?? {}
  const knownHosts = await getGlabKnownHosts(connectionId, localGitOptions)
  const projectRef = await getProjectRef(repoPath, knownHosts, connectionId, ...localGitArgs)
  if (!projectRef) {
    return null
  }
  await acquire()
  try {
    if (typeof linkedMRIid === 'number') {
      const { stdout } = await glabExecFileAsync(
        [
          'api',
          ...glabHostnameArgs(projectRef, connectionId),
          `projects/${encodedProject(projectRef.path)}/merge_requests/${linkedMRIid}?with_merge_status_recheck=true`
        ],
        glabRepoExecOptions(repoPath, connectionId, localGitOptions)
      )
      const raw = JSON.parse(stdout) as GitLabMRPipelineRaw
      const pipelineStatus = derivePipelineStatus(raw.head_pipeline ?? raw.pipeline ?? null)
      return withUnresolvedCommentCount(
        mapMRInfo(raw, pipelineStatus),
        raw,
        repoPath,
        projectRef,
        connectionId,
        localGitOptions
      )
    }
    if (branchName) {
      const { stdout } = await glabExecFileAsync(
        [
          'api',
          ...glabHostnameArgs(projectRef, connectionId),
          // Why: GitLab does not proactively recompute merge status on list endpoints, so this row
          // can sit at `unchecked` forever — and the sidebar merge button gates on MERGEABLE. Ask
          // for the async recalculation (best-effort; ignored for non-Developers when
          // `restrict_merge_status_recheck` is on) so polling converges instead of stalling.
          `projects/${encodedProject(projectRef.path)}/merge_requests?source_branch=${encodeURIComponent(branchName)}&order_by=updated_at&sort=desc&per_page=1&with_merge_status_recheck=true`
        ],
        glabRepoExecOptions(repoPath, connectionId, localGitOptions)
      )
      const data = JSON.parse(stdout) as GitLabMRPipelineRaw[]
      if (Array.isArray(data) && data.length > 0) {
        const raw = data[0]
        // Why: older GitLab list payloads expose `pipeline` instead of `head_pipeline`.
        const pipelineStatus = derivePipelineStatus(raw.head_pipeline ?? raw.pipeline ?? null)
        const info = mapMRInfo(raw, pipelineStatus)
        // Why (#9171): discard a non-open implicit branch match on the repo default branch.
        const hideOnDefaultBranch = await shouldHideNonOpenReviewOnDefaultBranch({
          state: info.state,
          reviewNumber: info.number,
          branchName,
          repoPath,
          connectionId,
          localGitOptions
        })
        if (!hideOnDefaultBranch) {
          return withUnresolvedCommentCount(
            info,
            raw,
            repoPath,
            projectRef,
            connectionId,
            localGitOptions
          )
        }
      }
    }
    return null
  } catch (error) {
    if (throwOnFailure) {
      throw error
    }
    return null
  } finally {
    release()
  }
}

/**
 * Like getMergeRequestForBranch but throws glab failures instead of returning null, so callers report 'unavailable' not a false "not found".
 */
export function getMergeRequestForBranchOrThrow(
  repoPath: string,
  branch: string,
  linkedMRIid?: number | null,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<MRInfo | null> {
  return getMergeRequestForBranch(repoPath, branch, linkedMRIid, connectionId, options, true)
}
