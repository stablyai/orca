import type { TaskSourceContext } from '../../shared/task-source-context'
import type {
  GetGiteaRateLimitResult,
  GiteaAssignableUser,
  GiteaAuthDiagnostic,
  GiteaCommentResult,
  GiteaDiscussionResolveResult,
  GiteaIssueCreateResult,
  GiteaIssueInfo,
  GiteaIssueListResult,
  GiteaIssueUpdate,
  GiteaJobTraceResult,
  GiteaMutationResult,
  GiteaNotification,
  GiteaPRInlineCommentInput,
  GiteaPRReviewersUpdateResult,
  GiteaPRUpdate,
  GiteaProjectRef,
  GiteaPullRequestInfo,
  GiteaReviewDecision,
  GiteaViewer,
  GiteaWorkItem,
  GiteaWorkItemDetails,
  ListGiteaPullRequestsResult,
  PRListState
} from '../../shared/gitea-types'

export type GiteaRepoSelectorArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
  /** Desktop IPC-only owner guard; web adapters remove it before runtime RPC. */
  repoOwnerExecutionHostId?: string
}

export type GiteaApi = {
  viewer: () => Promise<GiteaViewer | null>
  diagnoseAuth: () => Promise<GiteaAuthDiagnostic>
  rateLimit: (args?: { force?: boolean; host?: string | null }) => Promise<GetGiteaRateLimitResult>
  projectSlug: (args: GiteaRepoSelectorArgs) => Promise<GiteaProjectRef | null>
  prForBranch: (
    args: GiteaRepoSelectorArgs & {
      branch: string
      linkedPRNumber?: number | null
    }
  ) => Promise<GiteaPullRequestInfo | null>
  pr: (args: GiteaRepoSelectorArgs & { number: number }) => Promise<GiteaPullRequestInfo | null>
  listPRs: (
    args: GiteaRepoSelectorArgs & {
      state?: PRListState
      page?: number
      perPage?: number
      query?: string
    }
  ) => Promise<ListGiteaPullRequestsResult>
  listWorkItems: (
    args: GiteaRepoSelectorArgs & {
      state?: PRListState
      page?: number
      perPage?: number
      query?: string
    }
  ) => Promise<ListGiteaPullRequestsResult>
  issue: (args: GiteaRepoSelectorArgs & { number: number }) => Promise<GiteaIssueInfo | null>
  listIssues: (
    args: GiteaRepoSelectorArgs & {
      state?: 'opened' | 'closed' | 'all'
      assignee?: string
      limit?: number
      page?: number
    }
  ) => Promise<GiteaIssueListResult>
  createIssue: (
    args: GiteaRepoSelectorArgs & {
      title: string
      body: string
    }
  ) => Promise<GiteaIssueCreateResult>
  updateIssue: (
    args: GiteaRepoSelectorArgs & {
      number: number
      updates: GiteaIssueUpdate
      projectRef?: GiteaProjectRef | null
    }
  ) => Promise<GiteaMutationResult>
  addIssueComment: (
    args: GiteaRepoSelectorArgs & {
      number: number
      body: string
      projectRef?: GiteaProjectRef | null
    }
  ) => Promise<GiteaCommentResult>
  listLabels: (args: GiteaRepoSelectorArgs) => Promise<string[]>
  listAssignableUsers: (args: GiteaRepoSelectorArgs) => Promise<GiteaAssignableUser[]>
  notifications: (args: GiteaRepoSelectorArgs) => Promise<GiteaNotification[]>
  markNotificationRead: (
    args: GiteaRepoSelectorArgs & { notificationId: number }
  ) => Promise<GiteaMutationResult>
  workItemDetails: (
    args: GiteaRepoSelectorArgs & {
      number: number
      type: 'issue' | 'pr'
      includeReviewDetails?: boolean
      projectRef?: GiteaProjectRef | null
      /** A checks-panel poll: refused rather than booting a stopped WSL distro. */
      background?: boolean
    }
  ) => Promise<GiteaWorkItemDetails | null>
  closePR: (
    args: GiteaRepoSelectorArgs & {
      number: number
      projectRef?: GiteaProjectRef | null
    }
  ) => Promise<GiteaMutationResult>
  reopenPR: (
    args: GiteaRepoSelectorArgs & {
      number: number
      projectRef?: GiteaProjectRef | null
    }
  ) => Promise<GiteaMutationResult>
  mergePR: (
    args: GiteaRepoSelectorArgs & {
      number: number
      method?: 'merge' | 'squash' | 'rebase' | 'rebase-merge'
      projectRef?: GiteaProjectRef | null
    }
  ) => Promise<GiteaMutationResult>
  updatePR: (
    args: GiteaRepoSelectorArgs & {
      number: number
      updates: GiteaPRUpdate
      projectRef?: GiteaProjectRef | null
    }
  ) => Promise<GiteaMutationResult>
  updatePRReviewers: (
    args: GiteaRepoSelectorArgs & {
      number: number
      reviewerUsernames: string[]
      projectRef?: GiteaProjectRef | null
    }
  ) => Promise<GiteaPRReviewersUpdateResult>
  addPRComment: (
    args: GiteaRepoSelectorArgs & {
      number: number
      body: string
      projectRef?: GiteaProjectRef | null
    }
  ) => Promise<GiteaCommentResult>
  addPRInlineComment: (
    args: GiteaRepoSelectorArgs & {
      number: number
      input: GiteaPRInlineCommentInput
      projectRef?: GiteaProjectRef | null
    }
  ) => Promise<GiteaCommentResult>
  resolvePRDiscussion: (
    args: GiteaRepoSelectorArgs & {
      number: number
      discussionId: string
      resolved: boolean
      projectRef?: GiteaProjectRef | null
    }
  ) => Promise<GiteaDiscussionResolveResult>
  submitPRReview: (
    args: GiteaRepoSelectorArgs & {
      number: number
      decision: GiteaReviewDecision
      body?: string
      projectRef?: GiteaProjectRef | null
    }
  ) => Promise<GiteaMutationResult>
  jobTrace: (
    args: GiteaRepoSelectorArgs & {
      jobId: number
      projectRef?: GiteaProjectRef | null
      logExcerpt?: boolean
    }
  ) => Promise<GiteaJobTraceResult>
  workItemByPath: (
    args: GiteaRepoSelectorArgs & {
      host: string
      path: string
      number: number
      type: 'issue' | 'pr'
    }
  ) => Promise<Omit<GiteaWorkItem, 'repoId'> | null>
}
