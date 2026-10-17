import type { MRInfo } from '../../shared/gitlab-types'
import { derivePipelineStatus, mapMRInfo } from './mappers'
import {
  acquire,
  getGlabKnownHosts,
  getProjectRef,
  getProjectRefForRemote,
  glabHostnameArgs,
  glabRepoExecOptions,
  glabExecFileAsync,
  release,
  type ProjectRef
} from './gl-utils'
import { encodedProject } from './project-path-encoding'
import {
  hasHostedReviewLocalGitOptions,
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../source-control/hosted-review-git-options'
import { shouldHideNonOpenReviewOnDefaultBranch } from '../source-control/repo-default-branch'
import {
  BRANCH_REVIEW_PAGE_SIZE,
  selectReviewForHead
} from '../source-control/branch-review-selection'
import { resolveBranchReviewTarget } from '../source-control/review-head'
import { getGitLabProjectId } from './gitlab-project-id'

type HostedReviewLocalGitOptions = ReturnType<typeof getHostedReviewLocalGitOptions>

type ListedMergeRequest = Parameters<typeof mapMRInfo>[0] & {
  head_pipeline?: { status?: string } | null
  pipeline?: { status?: string } | null
}

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
    const data = JSON.parse(stdout) as Parameters<typeof mapMRInfo>[0] & {
      head_pipeline?: { status?: string } | null
      pipeline?: { status?: string } | null
    }
    // Why: older GitLab instances expose `pipeline` instead of `head_pipeline`; try both.
    const pipelineStatus = derivePipelineStatus(data.head_pipeline ?? data.pipeline ?? null)
    return mapMRInfo(data, pipelineStatus)
  } catch {
    return null
  } finally {
    release()
  }
}

/**
 * Find the explicitly linked merge request, or the MR whose source is where this branch is pushed
 * (the open one first, else the newest). Returns null when neither exists.
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
  const { linkedNumber: linkedIid, head: branchHead } = await resolveBranchReviewTarget(
    repoPath,
    branchName,
    linkedMRIid,
    connectionId,
    localGitOptions
  )
  const headProject = !branchHead
    ? null
    : branchHead.remote === 'origin'
      ? projectRef
      : await getProjectRefForRemote(
          repoPath,
          branchHead.remote,
          knownHosts,
          connectionId,
          localGitOptions
        )
  await acquire()
  try {
    if (typeof linkedIid === 'number') {
      const { stdout } = await glabExecFileAsync(
        [
          'api',
          ...glabHostnameArgs(projectRef, connectionId),
          `projects/${encodedProject(projectRef.path)}/merge_requests/${linkedIid}?with_merge_status_recheck=true`
        ],
        glabRepoExecOptions(repoPath, connectionId, localGitOptions)
      )
      const raw = JSON.parse(stdout) as Parameters<typeof mapMRInfo>[0] & {
        head_pipeline?: { status?: string } | null
        pipeline?: { status?: string } | null
      }
      const pipelineStatus = derivePipelineStatus(raw.head_pipeline ?? raw.pipeline ?? null)
      return mapMRInfo(raw, pipelineStatus)
    }
    if (branchHead && headProject && headProject.host === projectRef.host) {
      const headProjectId = await getGitLabProjectId(
        headProject,
        repoPath,
        connectionId,
        localGitOptions
      )
      if (headProjectId === null) {
        return null
      }
      const raw = await selectReviewForHead(
        async (states) => {
          const { stdout } = await glabExecFileAsync(
            [
              'api',
              ...glabHostnameArgs(projectRef, connectionId),
              // Why: GitLab does not proactively recompute merge status on list endpoints, so this row
              // can sit at `unchecked` forever — and the sidebar merge button gates on MERGEABLE. Ask
              // for the async recalculation (best-effort; ignored for non-Developers when
              // `restrict_merge_status_recheck` is on) so polling converges instead of stalling.
              `projects/${encodedProject(projectRef.path)}/merge_requests?source_project_id=${headProjectId}&source_branch=${encodeURIComponent(branchHead.branch)}${states === 'open' ? '&state=opened' : ''}&order_by=updated_at&sort=desc&per_page=${BRANCH_REVIEW_PAGE_SIZE}&with_merge_status_recheck=true`
            ],
            glabRepoExecOptions(repoPath, connectionId, localGitOptions)
          )
          const data: ListedMergeRequest[] = JSON.parse(stdout)
          // Why: servers older than 11.10 ignore `source_project_id`.
          return Array.isArray(data)
            ? data.filter((mr) => mr.source_project_id === headProjectId)
            : []
        },
        (mr) => mr.state?.toLowerCase() === 'opened'
      )
      if (raw) {
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
          return info
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
