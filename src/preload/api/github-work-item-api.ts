import type {
  GetProjectViewTableResult,
  GitHubProjectCommentMutationResult,
  GitHubProjectMutationResult,
  ListAccessibleProjectsResult,
  ListAssignableUsersBySlugResult,
  ListIssueTypesBySlugResult,
  ListLabelsBySlugResult,
  ListProjectViewsResult,
  ProjectWorkItemDetailsBySlugResult,
  ResolveProjectRefResult
} from '../../shared/github/project-result-types'
import type {
  AddIssueCommentBySlugArgs,
  ClearProjectItemFieldArgs,
  DeleteIssueCommentBySlugArgs,
  GetProjectViewTableArgs,
  ListAccessibleProjectsArgs,
  ListAssignableUsersBySlugArgs,
  ListIssueTypesBySlugArgs,
  ListLabelsBySlugArgs,
  ListProjectViewsArgs,
  ProjectWorkItemDetailsBySlugArgs,
  ResolveProjectRefArgs,
  UpdateIssueBySlugArgs,
  UpdateIssueCommentBySlugArgs,
  UpdateIssueTypeBySlugArgs,
  UpdateProjectItemFieldArgs,
  UpdatePullRequestBySlugArgs
} from '../../shared/github/project-request-types'
import type { TaskSourceContext } from '../../shared/task-source-context'
import type { GitHubCommentResult } from '../../shared/github/comment-types'
import type {
  GitHubAssignableUser,
  GitHubOwnerRepo,
  IssueInfo
} from '../../shared/github/pull-request-types'
import type {
  GitHubWorkItem,
  GitHubWorkItemDetails,
  ListWorkItemsResult
} from '../../shared/github/work-item-types'
import type { GitHubCreateIssueResult, GitHubIssueUpdate } from '../../shared/issue-mutation-types'

export type GitHubRepoSelectorArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
}

export type GithubWorkItemApi = {
  issue: (args: {
    repoPath: string
    repoId?: string
    sourceContext?: TaskSourceContext | null
    number: number
  }) => Promise<IssueInfo | null>
  workItem: (args: {
    repoPath: string
    repoId?: string
    sourceContext?: TaskSourceContext | null
    number: number
    type?: 'issue' | 'pr'
  }) => Promise<Omit<GitHubWorkItem, 'repoId'> | null>
  workItemByOwnerRepo: (args: {
    repoPath: string
    repoId?: string
    owner: string
    repo: string
    host?: string
    number: number
    type: 'issue' | 'pr'
  }) => Promise<Omit<GitHubWorkItem, 'repoId'> | null>
  workItemDetails: (
    args: GitHubRepoSelectorArgs & {
      number: number
      type?: 'issue' | 'pr'
    }
  ) => Promise<GitHubWorkItemDetails | null>
  notifyWorkItemMutated: (args: {
    repoPath: string
    repoId?: string
    type: 'issue' | 'pr'
    number: number
  }) => Promise<boolean>
  listIssues: (args: { repoPath: string; repoId?: string; limit?: number }) => Promise<IssueInfo[]>
  createIssue: (args: {
    repoPath: string
    repoId?: string
    sourceContext?: TaskSourceContext | null
    title: string
    body: string
    labels?: string[]
    assignees?: string[]
  }) => Promise<GitHubCreateIssueResult>
  countWorkItems: (args: { repoPath: string; repoId?: string; query?: string }) => Promise<number>
  listWorkItems: (args: {
    repoPath: string
    repoId?: string
    limit?: number
    query?: string
    page?: number
    noCache?: boolean
  }) => Promise<ListWorkItemsResult<Omit<GitHubWorkItem, 'repoId'>>>
  updateIssue: (
    args: GitHubRepoSelectorArgs & {
      number: number
      updates: GitHubIssueUpdate
    }
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  addIssueComment: (
    args: GitHubRepoSelectorArgs & {
      number: number
      body: string
      /** Why: scopes the cross-window cache invalidation so a PR and issue sharing the same number don't evict each other. */
      type?: 'issue' | 'pr'
      prRepo?: GitHubOwnerRepo | null
    }
  ) => Promise<GitHubCommentResult>
  listLabels: (args: {
    repoPath: string
    repoId?: string
    sourceContext?: TaskSourceContext | null
  }) => Promise<string[]>
  listAssignableUsers: (args: {
    repoPath: string
    repoId?: string
    sourceContext?: TaskSourceContext | null
  }) => Promise<GitHubAssignableUser[]>
  /** Subscribe to local-mutation broadcasts so the work-item-drawer cache can invalidate across windows. Returns an unsubscribe. */
  onWorkItemMutated: (
    callback: (payload: {
      repoPath: string
      repoId?: string
      type: 'issue' | 'pr'
      number: number
    }) => void
  ) => () => void
  // ── ProjectV2 (GitHub Projects) ─────────────────────────────────
  listAccessibleProjects: (
    args?: ListAccessibleProjectsArgs
  ) => Promise<ListAccessibleProjectsResult>
  resolveProjectRef: (args: ResolveProjectRefArgs) => Promise<ResolveProjectRefResult>
  listProjectViews: (args: ListProjectViewsArgs) => Promise<ListProjectViewsResult>
  getProjectViewTable: (args: GetProjectViewTableArgs) => Promise<GetProjectViewTableResult>
  projectWorkItemDetailsBySlug: (
    args: ProjectWorkItemDetailsBySlugArgs
  ) => Promise<ProjectWorkItemDetailsBySlugResult>
  updateProjectItemField: (args: UpdateProjectItemFieldArgs) => Promise<GitHubProjectMutationResult>
  clearProjectItemField: (args: ClearProjectItemFieldArgs) => Promise<GitHubProjectMutationResult>
  updateIssueBySlug: (args: UpdateIssueBySlugArgs) => Promise<GitHubProjectMutationResult>
  updatePullRequestBySlug: (
    args: UpdatePullRequestBySlugArgs
  ) => Promise<GitHubProjectMutationResult>
  addIssueCommentBySlug: (
    args: AddIssueCommentBySlugArgs
  ) => Promise<GitHubProjectCommentMutationResult>
  updateIssueCommentBySlug: (
    args: UpdateIssueCommentBySlugArgs
  ) => Promise<GitHubProjectMutationResult>
  deleteIssueCommentBySlug: (
    args: DeleteIssueCommentBySlugArgs
  ) => Promise<GitHubProjectMutationResult>
  listLabelsBySlug: (args: ListLabelsBySlugArgs) => Promise<ListLabelsBySlugResult>
  listAssignableUsersBySlug: (
    args: ListAssignableUsersBySlugArgs
  ) => Promise<ListAssignableUsersBySlugResult>
  listIssueTypesBySlug: (args: ListIssueTypesBySlugArgs) => Promise<ListIssueTypesBySlugResult>
  updateIssueTypeBySlug: (args: UpdateIssueTypeBySlugArgs) => Promise<GitHubProjectMutationResult>
}
