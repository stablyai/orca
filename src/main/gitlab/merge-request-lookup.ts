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
  type ProjectRef
} from './gl-utils'
import { encodedProject } from './project-path-encoding'
import {
  hasHostedReviewLocalGitOptions,
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../source-control/hosted-review-git-options'
import { shouldHideNonOpenReviewOnDefaultBranch } from '../source-control/repo-default-branch'

type HostedReviewLocalGitOptions = ReturnType<typeof getHostedReviewLocalGitOptions>

export type GitLabBranchLookupOptions = HostedReviewExecutionOptions & {
  /** The worktree HEAD; a merged branch match counts only while the checkout still sits on its head. */
  currentHeadOid?: string | null
}

// Why: sorted by update time, a page of one lets a newer closed or merged MR hide the open one.
const BRANCH_MR_LOOKUP_PAGE_SIZE = 10

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

/** Failures and confirmed absence return null. */
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

export async function getMergeRequestForBranch(
  repoPath: string,
  branch: string,
  linkedMRIid?: number | null,
  connectionId?: string | null,
  options: GitLabBranchLookupOptions = {},
  // Strict callers need failures distinguished from confirmed missing reviews.
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
    const fetchByIid = async (iid: number): Promise<MRInfo> => {
      const { stdout } = await glabExecFileAsync(
        [
          'api',
          ...glabHostnameArgs(projectRef, connectionId),
          `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}?with_merge_status_recheck=true`
        ],
        glabRepoExecOptions(repoPath, connectionId, localGitOptions)
      )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the single-MR endpoint returns the MR fields and its optional pipeline.
      const raw = JSON.parse(stdout) as Parameters<typeof mapMRInfo>[0]
      const pipelineStatus = derivePipelineStatus(raw.head_pipeline ?? raw.pipeline ?? null)
      return mapMRInfo(raw, pipelineStatus)
    }
    if (typeof linkedMRIid === 'number') {
      return await fetchByIid(linkedMRIid)
    }
    if (branchName) {
      const { stdout } = await glabExecFileAsync(
        [
          'api',
          ...glabHostnameArgs(projectRef, connectionId),
          // List endpoints need asynchronous merge-status recheck; GitLab may restrict this to Developers.
          `projects/${encodedProject(projectRef.path)}/merge_requests?source_branch=${encodeURIComponent(branchName)}&order_by=updated_at&sort=desc&per_page=${BRANCH_MR_LOOKUP_PAGE_SIZE}&with_merge_status_recheck=true`
        ],
        glabRepoExecOptions(repoPath, connectionId, localGitOptions)
      )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the branch-list endpoint returns MR summaries; only their identity and state are used.
      const data = JSON.parse(stdout) as Parameters<typeof mapMRInfo>[0][]
      const match = Array.isArray(data)
        ? (data.find((mr) => mr.state?.toLowerCase() === 'opened') ?? data[0])
        : undefined
      if (match) {
        // List summaries omit head_pipeline; only detail can supply an authoritative check result.
        const info = await fetchByIid(match.iid ?? match.number ?? 0)
        const headOid = options.currentHeadOid?.trim() || null
        // A merged match is history once the checkout moves past its head, e.g. a long-lived branch.
        if (info.state === 'merged' && headOid !== null && info.headSha !== headOid) {
          return null
        }
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

/** Preserve lookup failures as unavailable rather than confirmed missing reviews. */
export function getMergeRequestForBranchOrThrow(
  repoPath: string,
  branch: string,
  linkedMRIid?: number | null,
  connectionId?: string | null,
  options: GitLabBranchLookupOptions = {}
): Promise<MRInfo | null> {
  return getMergeRequestForBranch(repoPath, branch, linkedMRIid, connectionId, options, true)
}
