import type {
  GitLabAssignableUser,
  GitLabWorkItem,
  GitLabWorkItemDetails
} from '../../shared/gitlab-types'
import type { IssueSourcePreference } from '../../shared/repo-types'
import { mapIssueToWorkItem, mapMRToWorkItem } from './mappers'
import { mapGitLabUser, type GitLabRawUser } from './gitlab-assignable-user-mapping'
import { encodedProject } from './project-path-encoding'
import { fetchDiscussions, flattenDiscussions } from './mr-discussion-notes'
import { fetchMRFiles } from './mr-file-diffs'
import { fetchMRApprovalState, fetchMRReviewers } from './mr-reviewers-and-approvals'
import { fetchPipelineJobs } from './pipeline-job-graph'
import {
  acquire,
  getGlabKnownHosts,
  glabHostnameArgs,
  glabRepoExecOptions,
  glabExecFileAsync,
  release,
  resolveIssueSource,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'

type GitLabRawIssue = Parameters<typeof mapIssueToWorkItem>[0] & {
  description?: string | null
  assignees?: { username?: string | null }[] | null
}

type GitLabRawMR = Parameters<typeof mapMRToWorkItem>[0] & {
  description?: string | null
  sha?: string
  diff_refs?: { base_sha?: string; head_sha?: string; start_sha?: string } | null
  head_pipeline?: { id?: number } | null
  reviewers?: GitLabRawUser[] | null
}

/** Return null for unresolved/unloadable items; include discussion, pipeline and optional review metadata. */
export async function getWorkItemDetails(
  repoPath: string,
  iid: number,
  type: 'issue' | 'mr',
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRefOverride?: ProjectRef | null,
  localGitOptions: LocalGitExecOptions = {},
  options: { includeReviewDetails?: boolean } = {}
): Promise<GitLabWorkItemDetails | null> {
  // Retain the list row's selected project to avoid same-number fork/upstream collisions.
  const projectRef =
    projectRefOverride ??
    (
      await resolveIssueSource(
        repoPath,
        preference,
        await getGlabKnownHosts(connectionId, localGitOptions),
        connectionId,
        localGitOptions
      )
    ).source
  if (!projectRef) {
    return null
  }
  await acquire()
  try {
    if (type === 'issue') {
      return await fetchIssueDetails(repoPath, projectRef, iid, connectionId, localGitOptions)
    }
    return await fetchMRDetails(repoPath, projectRef, iid, connectionId, localGitOptions, options)
  } catch {
    return null
  } finally {
    release()
  }
}

async function fetchIssueDetails(
  repoPath: string,
  projectRef: ProjectRef,
  iid: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabWorkItemDetails | null> {
  const [issueRes, discussions] = await Promise.all([
    glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, connectionId),
        `projects/${encodedProject(projectRef.path)}/issues/${iid}`
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    ),
    fetchDiscussions(repoPath, projectRef, 'issue', iid, connectionId, localGitOptions)
  ])
  const issueRaw = JSON.parse(issueRes.stdout) as GitLabRawIssue
  const item: Omit<GitLabWorkItem, 'repoId'> = (() => {
    const full = mapIssueToWorkItem(issueRaw, projectRef.path, projectRef)
    // The renderer supplies Orca repoId; main knows only the repository path.
    const { repoId: _repoId, ...rest } = full
    return rest
  })()
  return {
    item,
    body: issueRaw.description ?? '',
    comments: flattenDiscussions(discussions),
    assignees: (issueRaw.assignees ?? [])
      .map((a) => a?.username)
      .filter((u): u is string => typeof u === 'string')
  }
}

async function fetchMRDetails(
  repoPath: string,
  projectRef: ProjectRef,
  iid: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  options: { includeReviewDetails?: boolean } = {}
): Promise<GitLabWorkItemDetails | null> {
  // Discussion can overlap MR details; child jobs need its head_pipeline ID.
  const [mrRes, discussions] = await Promise.all([
    glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, connectionId),
        `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}`
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    ),
    fetchDiscussions(repoPath, projectRef, 'mr', iid, connectionId, localGitOptions)
  ])
  const mrRaw = JSON.parse(mrRes.stdout) as GitLabRawMR
  const item: Omit<GitLabWorkItem, 'repoId'> = (() => {
    const full = mapMRToWorkItem(mrRaw, projectRef.path, projectRef)
    const { repoId: _repoId, ...rest } = full
    return rest
  })()
  const pipelineId = mrRaw.head_pipeline?.id
  const pipelineJobs =
    typeof pipelineId === 'number'
      ? await fetchPipelineJobs(
          repoPath,
          projectRef,
          pipelineId,
          connectionId,
          localGitOptions
        ).catch(() => [])
      : undefined
  // Checks needs pipeline/discussion data without the dialog's optional review enrichment.
  const includeReviewDetails = options.includeReviewDetails !== false
  const [reviewers, approvalState, files] = await Promise.all([
    includeReviewDetails
      ? fetchMRReviewers(repoPath, projectRef, iid, connectionId, localGitOptions).catch(() =>
          (mrRaw.reviewers ?? []).map(mapGitLabUser).filter((u): u is GitLabAssignableUser => !!u)
        )
      : [],
    includeReviewDetails
      ? fetchMRApprovalState(repoPath, projectRef, iid, connectionId, localGitOptions).catch(
          () => undefined
        )
      : undefined,
    includeReviewDetails
      ? fetchMRFiles(repoPath, projectRef, iid, connectionId, localGitOptions).catch(() => [])
      : []
  ])
  return {
    item,
    body: mrRaw.description ?? '',
    comments: flattenDiscussions(discussions),
    headSha: mrRaw.sha,
    baseSha: mrRaw.diff_refs?.base_sha,
    startSha: mrRaw.diff_refs?.start_sha,
    files,
    ...(pipelineJobs !== undefined ? { pipelineJobs } : {}),
    reviewers,
    ...(approvalState ? { approvalState } : {})
  }
}
