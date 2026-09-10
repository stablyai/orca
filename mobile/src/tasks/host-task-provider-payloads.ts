import type {
  DetailComment,
  GitHubAssignableUser,
  GitHubDetailCheck,
  GitHubDetailFile,
  GitHubPRMergeableState,
  GitHubPRReviewSummary,
  GitHubRepoSources,
  GitHubWorkItem,
  GitLabWorkItem,
  LinearIssue
} from './mobile-tasks-provider-detail-types'
import type { LinearFilter } from './mobile-tasks-view-state-types'

export type HostTaskGitHubDetailPayload = {
  repoId: string
  number: number
  type: 'issue' | 'pr'
}

/** The host's work-item detail as the task screens read it: `provider` is the caller's, and the
 *  item-level fields stay optional so a caller can fall back to the row it already has. */
export type HostTaskGitHubDetail = {
  body: string
  comments: DetailComment[]
  labels?: string[]
  assignees: string[]
  reviewDecision?: string | null
  reviewRequests?: GitHubAssignableUser[]
  latestReviews?: GitHubPRReviewSummary[]
  headSha?: string
  baseSha?: string
  pullRequestId?: string
  checks: GitHubDetailCheck[]
  files: GitHubDetailFile[]
}

export type HostTaskGitLabDetail = {
  body: string
  comments: DetailComment[]
  labels?: string[]
  assignees: string[]
  item?: { mergeable?: GitHubPRMergeableState }
  reviewers?: unknown[]
  approvalState?: { approvalsRequired: number | null; approvalsLeft: number | null }
  pipelineJobs: Array<{
    id?: number
    name: string
    stage: string
    status: string
    webUrl?: string | null
    duration?: number | null
  }>
}

export type HostTaskLinearDetail = {
  issue: LinearIssue
  comments: DetailComment[]
}

export type HostTaskGitHubListPayload = {
  repoId: string
  limit: number
  query: string
  before?: string
}

export type HostTaskGitHubListResult = {
  items: Array<Omit<GitHubWorkItem, 'repoId' | 'repoName'>>
  sources?: GitHubRepoSources
  errors?: { issues?: { message: string } }
  issueSourceFellBack?: true
}

export type HostTaskGitHubCountPayload = {
  repoId: string
  query: string
}

export type HostTaskGitLabListPayload = {
  repoId: string
  state: 'opened' | 'merged' | 'closed' | 'all'
  page: number
  perPage: number
  query?: string
}

export type HostTaskGitLabListResult = {
  items: Array<Omit<GitLabWorkItem, 'repoId' | 'repoName'>>
  error?: { type?: string; message: string }
}

export type HostTaskLinearListPayload = {
  query?: string
  filter?: LinearFilter
  limit: number
  workspaceId?: string
}

export type HostTaskLinearCreatedIssue = {
  id: string
  identifier: string
  title?: string
  url?: string
}
