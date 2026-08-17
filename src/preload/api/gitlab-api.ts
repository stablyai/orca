import type { TaskSourceContext } from '../../shared/task-source-context'
import type { ClassifiedError } from '../../shared/classified-error'
import type {
  GetGitLabRateLimitResult,
  GitLabAssignableUser,
  GitLabAuthDiagnostic,
  GitLabCommentResult,
  GitLabDiscussionResolveResult,
  GitLabIssueInfo,
  GitLabIssueUpdate,
  GitLabJobTraceResult,
  GitLabMRInlineCommentInput,
  GitLabMRReviewersUpdateResult,
  GitLabMRUpdate,
  GitLabProjectRef,
  GitLabRetryJobResult,
  GitLabTodo,
  GitLabViewer,
  GitLabWorkItem,
  GitLabWorkItemDetails,
  ListMergeRequestsResult,
  MRInfo,
  MRListState
} from '../../shared/gitlab-types'

export type GitLabRepoSelectorArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
}

// ── GitLab — parallel to gh, MR/issue surface only in v1 ────────
// Shapes mirror gh.* except where GitLab's API differs (MR states, host-qualified project path, `glab api -i` paging).
export type GitLabApi = {
  viewer: () => Promise<GitLabViewer | null>
  diagnoseAuth: () => Promise<GitLabAuthDiagnostic>
  rateLimit: (args?: { force?: boolean; host?: string | null }) => Promise<GetGitLabRateLimitResult>
  projectSlug: (args: GitLabRepoSelectorArgs) => Promise<GitLabProjectRef | null>
  mrForBranch: (
    args: GitLabRepoSelectorArgs & {
      branch: string
      linkedMRIid?: number | null
    }
  ) => Promise<MRInfo | null>
  mr: (args: GitLabRepoSelectorArgs & { iid: number }) => Promise<MRInfo | null>
  listMRs: (
    args: GitLabRepoSelectorArgs & {
      state?: MRListState
      page?: number
      perPage?: number
      query?: string
    }
  ) => Promise<ListMergeRequestsResult>
  /** Combined MR + issue list filtered by state. Issues are skipped
   *  when state is 'merged' (issues don't merge). */
  listWorkItems: (
    args: GitLabRepoSelectorArgs & {
      state?: MRListState
      page?: number
      perPage?: number
      query?: string
    }
  ) => Promise<ListMergeRequestsResult>
  issue: (args: GitLabRepoSelectorArgs & { number: number }) => Promise<GitLabIssueInfo | null>
  listIssues: (
    args: GitLabRepoSelectorArgs & {
      state?: 'opened' | 'closed' | 'all'
      assignee?: string
      limit?: number
    }
  ) => Promise<{ items: GitLabWorkItem[]; error?: ClassifiedError }>
  createIssue: (
    args: GitLabRepoSelectorArgs & {
      title: string
      body: string
    }
  ) => Promise<{ ok: true; number: number; url: string } | { ok: false; error: string }>
  updateIssue: (
    args: GitLabRepoSelectorArgs & {
      number: number
      updates: GitLabIssueUpdate
    }
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  addIssueComment: (
    args: GitLabRepoSelectorArgs & {
      number: number
      body: string
    }
  ) => Promise<GitLabCommentResult>
  listLabels: (args: GitLabRepoSelectorArgs) => Promise<string[]>
  listAssignableUsers: (args: GitLabRepoSelectorArgs) => Promise<GitLabAssignableUser[]>
  /** Cross-project user-scoped todos (gitlab.com/dashboard/todos). */
  todos: (args: GitLabRepoSelectorArgs) => Promise<GitLabTodo[]>
  /** Aggregated dialog payload — body + discussions + pipeline jobs. */
  workItemDetails: (
    args: GitLabRepoSelectorArgs & {
      iid: number
      type: 'issue' | 'mr'
    }
  ) => Promise<GitLabWorkItemDetails | null>
  closeMR: (
    args: GitLabRepoSelectorArgs & {
      iid: number
    }
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  reopenMR: (
    args: GitLabRepoSelectorArgs & {
      iid: number
    }
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  mergeMR: (
    args: GitLabRepoSelectorArgs & {
      iid: number
      method?: 'merge' | 'squash' | 'rebase'
    }
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  updateMR: (
    args: GitLabRepoSelectorArgs & {
      iid: number
      updates: GitLabMRUpdate
    }
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  updateMRReviewers: (
    args: GitLabRepoSelectorArgs & {
      iid: number
      reviewerIds: number[]
      projectRef?: GitLabProjectRef | null
    }
  ) => Promise<GitLabMRReviewersUpdateResult>
  addMRComment: (
    args: GitLabRepoSelectorArgs & {
      iid: number
      body: string
    }
  ) => Promise<GitLabCommentResult>
  addMRInlineComment: (
    args: GitLabRepoSelectorArgs & {
      iid: number
      input: GitLabMRInlineCommentInput
      projectRef?: GitLabProjectRef | null
    }
  ) => Promise<GitLabCommentResult>
  resolveMRDiscussion: (
    args: GitLabRepoSelectorArgs & {
      iid: number
      discussionId: string
      resolved: boolean
    }
  ) => Promise<GitLabDiscussionResolveResult>
  jobTrace: (
    args: GitLabRepoSelectorArgs & {
      jobId: number
      projectRef?: GitLabProjectRef | null
      /** Bound the trace in main to a readable excerpt (see gitLabJobTraceToLogExcerpt). */
      logExcerpt?: boolean
    }
  ) => Promise<GitLabJobTraceResult>
  retryJob: (
    args: GitLabRepoSelectorArgs & {
      jobId: number
      projectRef?: GitLabProjectRef | null
    }
  ) => Promise<GitLabRetryJobResult>
  workItemByPath: (
    args: GitLabRepoSelectorArgs & {
      host: string
      path: string
      iid: number
      type: 'issue' | 'mr'
    }
  ) => Promise<Omit<GitLabWorkItem, 'repoId'> | null>
}
