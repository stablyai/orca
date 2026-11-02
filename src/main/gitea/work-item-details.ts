import type { MRComment } from '../../shared/gitlab-types'
import type { IssueSourcePreference } from '../../shared/repo-types'
import { fetchGiteaPipelineJobs, type GiteaPipelineJob } from './actions-job-graph'
import { requestGiteaJson } from './client'
import { resolveGiteaIssueSource } from './gitea-issue-source-resolution'
import { mapGiteaIssueInfo, mapGiteaIssueInfoToWorkItem, type RawGiteaIssue } from './mappers'
import {
  fetchGiteaIssueComments,
  fetchGiteaPRCommentsAndReviews,
  type RawGiteaReview
} from './pr-discussion-comments'
import { fetchGiteaPRFiles, type GiteaPRFile } from './pr-file-diffs'
import {
  giteaReviewersAndApproval,
  type GiteaApprovalState,
  type GiteaAssignableUser
} from './pr-reviewers-and-approvals'
import {
  mapGiteaPRToWorkItem,
  type GiteaWorkItem,
  type RawGiteaPullRequest
} from './pull-request-mappers'
import type { GiteaRepoRef, LocalGitExecOptions } from './repository-ref'
import { repoRefForProject, type GiteaProjectRef } from './work-item-queries'

export type GiteaWorkItemDetails = {
  item: Omit<GiteaWorkItem, 'repoId'>
  body: string
  comments: MRComment[]
  headSha?: string
  baseSha?: string
  files?: GiteaPRFile[]
  reviewers?: GiteaAssignableUser[]
  approvalState?: GiteaApprovalState
  assignees?: string[]
  pipelineJobs?: GiteaPipelineJob[]
}

type ReviewLoad = {
  comments: MRComment[]
  reviews: RawGiteaReview[]
  files: GiteaPRFile[]
}

function resourcePath(repo: GiteaRepoRef, kind: 'issues' | 'pulls', index: number): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/${kind}/${encodeURIComponent(String(index))}`
}

function withoutRepoId(item: GiteaWorkItem): Omit<GiteaWorkItem, 'repoId'> {
  const { repoId, ...rest } = item
  void repoId
  return rest
}

async function resolveRepo(
  repoPath: string,
  preference: IssueSourcePreference | undefined,
  connectionId: string | null | undefined,
  projectRefOverride: GiteaProjectRef | null | undefined,
  localGitOptions: LocalGitExecOptions
): Promise<GiteaRepoRef | null> {
  if (projectRefOverride) {
    return repoRefForProject(projectRefOverride, connectionId, localGitOptions)
  }
  const resolved = await resolveGiteaIssueSource(
    repoPath,
    preference,
    connectionId,
    localGitOptions
  )
  return resolved.source
}

async function loadReviewDetails(
  repo: GiteaRepoRef,
  index: number,
  includeReviewDetails: boolean,
  connectionId?: string | null,
  localGitOptions?: LocalGitExecOptions
): Promise<ReviewLoad> {
  if (!includeReviewDetails) {
    return {
      comments: await fetchGiteaIssueComments(repo, index, connectionId, localGitOptions),
      reviews: [],
      files: []
    }
  }
  const [discussion, files] = await Promise.all([
    fetchGiteaPRCommentsAndReviews(repo, index, connectionId, localGitOptions),
    fetchGiteaPRFiles(repo, index, connectionId, localGitOptions)
  ])
  return { comments: discussion.comments, reviews: discussion.reviews, files }
}

async function fetchIssueDetails(
  repo: GiteaRepoRef,
  index: number,
  connectionId?: string | null,
  localGitOptions?: LocalGitExecOptions
): Promise<GiteaWorkItemDetails | null> {
  const [raw, comments] = await Promise.all([
    requestGiteaJson<RawGiteaIssue>(repo, resourcePath(repo, 'issues', index), {
      allowNotFound: true
    }),
    fetchGiteaIssueComments(repo, index, connectionId, localGitOptions)
  ])
  if (!raw || raw.pull_request != null) {
    return null
  }
  const issue = mapGiteaIssueInfo(raw)
  if (!issue) {
    return null
  }
  const item = mapGiteaIssueInfoToWorkItem(issue, `${repo.owner}/${repo.repo}`)
  return {
    item: withoutRepoId(item),
    body: issue.body,
    comments,
    assignees: issue.assignees
  }
}

async function fetchPullDetails(
  repo: GiteaRepoRef,
  index: number,
  connectionId?: string | null,
  localGitOptions?: LocalGitExecOptions,
  options: { includeReviewDetails?: boolean } = {}
): Promise<GiteaWorkItemDetails | null> {
  const includeReviewDetails = options.includeReviewDetails !== false
  const [raw, review] = await Promise.all([
    requestGiteaJson<RawGiteaPullRequest>(repo, resourcePath(repo, 'pulls', index), {
      allowNotFound: true
    }),
    loadReviewDetails(repo, index, includeReviewDetails, connectionId, localGitOptions)
  ])
  if (!raw) {
    return null
  }
  const item = mapGiteaPRToWorkItem(raw, `${repo.owner}/${repo.repo}`)
  if (!item) {
    return null
  }
  const headSha = raw.head?.sha?.trim()
  const baseSha = raw.base?.sha?.trim()
  const approval = includeReviewDetails
    ? giteaReviewersAndApproval(raw.requested_reviewers, review.reviews)
    : null
  const pipelineJobs = headSha
    ? await fetchGiteaPipelineJobs(repo, headSha, connectionId, localGitOptions).catch(() =>
        emptyPipelineJobs()
      )
    : undefined
  return {
    item: withoutRepoId(item),
    body: raw.body ?? '',
    comments: review.comments,
    ...(headSha ? { headSha } : {}),
    ...(baseSha ? { baseSha } : {}),
    files: review.files,
    reviewers: approval?.reviewers ?? [],
    ...(approval ? { approvalState: approval.approvalState } : {}),
    ...(pipelineJobs !== undefined ? { pipelineJobs } : {})
  }
}

function emptyPipelineJobs(): GiteaPipelineJob[] {
  return []
}

export async function getGiteaWorkItemDetails(
  repoPath: string,
  index: number,
  type: 'issue' | 'pr',
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRefOverride?: GiteaProjectRef | null,
  localGitOptions: LocalGitExecOptions = {},
  options: { includeReviewDetails?: boolean } = {}
): Promise<GiteaWorkItemDetails | null> {
  const repo = await resolveRepo(
    repoPath,
    preference,
    connectionId,
    projectRefOverride,
    localGitOptions
  )
  if (!repo) {
    return null
  }
  try {
    if (type === 'issue') {
      return await fetchIssueDetails(repo, index, connectionId, localGitOptions)
    }
    return await fetchPullDetails(repo, index, connectionId, localGitOptions, options)
  } catch {
    return null
  }
}
