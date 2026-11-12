import type {
  GitLabAssignableUser,
  GitLabWorkItem,
  GitLabWorkItemDetails
} from '../../../shared/gitlab-types'
import type { IssueSourcePreference } from '../../../shared/repo-types'
import {
  derivePipelineStatus,
  mapIssueToWorkItem,
  mapMRToWorkItem,
  settleManualPipelineStatus
} from '../requests/gitlab-response-mapping'
import { mapGitLabUser, type GitLabRawUser } from '../projects/gitlab-assignable-user-mapping'
import { encodedProject } from '../projects/project-path-encoding'
import { fetchDiscussionComments } from '../merge-requests/mr-discussion-notes'
import { fetchMRFiles } from '../merge-requests/mr-file-diffs'
import {
  fetchMRApprovalState,
  fetchMRReviewers
} from '../merge-requests/mr-reviewers-and-approvals'
import { fetchPipelineJobs } from '../pipelines/pipeline-job-graph'
import { GitLabIncompletePaginationError } from '../requests/gitlab-paginated-list'
import { gitLabRunTimes } from '../pipelines/gitlab-run-times'
import { acquire, release } from '../requests/glab-request-admission'
import { getGlabKnownHosts, type LocalGitExecOptions } from '../projects/gitlab-known-host-probe'
import { glabHostnameArgs, glabRepoExecOptions } from '../projects/gitlab-project-ref-resolution'
import { glabExecFileAsync } from '../../git/command-runner/hosted-cli/glab-exec-file'
import { resolveIssueSource } from '../issues/gitlab-issue-source-resolution'
import type { ProjectRef } from '../projects/project-ref-parser'

type GitLabRawIssue = Parameters<typeof mapIssueToWorkItem>[0] & {
  description?: string | null
  assignees?: { username?: string | null }[] | null
}

type GitLabRawPipeline = {
  id?: number
  status?: string
  web_url?: string | null
  sha?: string | null
  ref?: string | null
  started_at?: string | null
  finished_at?: string | null
}

type GitLabRawMR = Parameters<typeof mapMRToWorkItem>[0] & {
  description?: string | null
  sha?: string
  diff_refs?: { base_sha?: string; head_sha?: string; start_sha?: string } | null
  head_pipeline?: GitLabRawPipeline | null
  pipeline?: GitLabRawPipeline | null
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
  options: { includeReviewDetails?: boolean; markViewerComments?: boolean } = {}
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
      return await fetchIssueDetails(
        repoPath,
        projectRef,
        iid,
        connectionId,
        localGitOptions,
        options.markViewerComments !== false
      )
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
  localGitOptions: LocalGitExecOptions = {},
  markViewerComments = true
): Promise<GitLabWorkItemDetails | null> {
  const [issueRes, comments] = await Promise.all([
    glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, connectionId),
        `projects/${encodedProject(projectRef.path)}/issues/${iid}`
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    ),
    fetchDiscussionComments(
      repoPath,
      projectRef,
      'issue',
      iid,
      connectionId,
      localGitOptions,
      markViewerComments
    )
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
    comments,
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
  options: { includeReviewDetails?: boolean; markViewerComments?: boolean } = {}
): Promise<GitLabWorkItemDetails | null> {
  // Discussion can overlap MR details; child jobs need its head_pipeline ID.
  const [mrRes, comments] = await Promise.all([
    glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, connectionId),
        `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}`
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    ),
    fetchDiscussionComments(
      repoPath,
      projectRef,
      'mr',
      iid,
      connectionId,
      localGitOptions,
      // Checks polling never reads viewerDidAuthor, so it skips the viewer lookup with the other review details.
      options.markViewerComments ?? options.includeReviewDetails !== false
    )
  ])
  const mrRaw = JSON.parse(mrRes.stdout) as GitLabRawMR
  const item: Omit<GitLabWorkItem, 'repoId'> = (() => {
    const full = mapMRToWorkItem(mrRaw, projectRef.path, projectRef)
    const { repoId: _repoId, ...rest } = full
    return rest
  })()
  const rawPipeline = mrRaw.head_pipeline ?? mrRaw.pipeline
  const pipelineId = rawPipeline?.id
  const pipelineJobs =
    typeof pipelineId === 'number'
      ? await fetchPipelineJobs(
          repoPath,
          projectRef,
          pipelineId,
          connectionId,
          localGitOptions
        ).catch((error: unknown) => {
          // A partial job list must fail the read so Checks and the dialog keep what they showed.
          if (error instanceof GitLabIncompletePaginationError) {
            throw error
          }
          return []
        })
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
    comments,
    headSha: mrRaw.sha,
    baseSha: mrRaw.diff_refs?.base_sha,
    startSha: mrRaw.diff_refs?.start_sha,
    files,
    ...(typeof pipelineId === 'number'
      ? {
          pipeline: {
            id: pipelineId,
            status: rawPipeline?.status ?? '',
            // The MR aggregate's own rule on this same reply, so both read one verdict.
            checkStatus: settleManualPipelineStatus(mrRaw, derivePipelineStatus(rawPipeline)),
            webUrl: rawPipeline?.web_url ?? null,
            ...(rawPipeline?.sha ? { sha: rawPipeline.sha } : {}),
            ...(rawPipeline?.ref ? { ref: rawPipeline.ref } : {}),
            ...(rawPipeline ? gitLabRunTimes(rawPipeline) : {})
          }
        }
      : {}),
    ...(pipelineJobs !== undefined ? { pipelineJobs } : {}),
    reviewers,
    ...(approvalState ? { approvalState } : {})
  }
}
