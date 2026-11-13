import type { GhAccountBinding } from '../../../shared/github/accounts/account-binding'
import type { AppStarSource } from '../../../shared/gh-star-source'
import type { GhAuthDiagnostic } from '../../../shared/github/accounts/auth-types'
import type { TaskSourceContext } from '../../../shared/work-items/task-source-context'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../shared/github/checks/check-types'
import type {
  GitHubCommentResult,
  GitHubPRReviewCommentInput,
  GitHubReactionContent,
  PRComment
} from '../../../shared/github/comments/comment-types'
import type {
  GitHubPRRefreshCandidate,
  GitHubPRRefreshEnqueueResult,
  GitHubPRRefreshEvent,
  GitHubPRRefreshReason,
  PRSnapshotReply
} from '../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../../../shared/github/repositories/repository-identity'
import type {
  GitHubPRFile,
  GitHubPRFileContents,
  GitHubViewer,
  PRInfo
} from '../../../shared/github/pull-requests/pull-request-types'
import type { GetRateLimitResult } from '../../../shared/github/api/rate-limit-types'
import type { GitHubRepoSelectorArgs } from './github-work-item-api'
import type {
  PRDetailRecoveryCancelArgs,
  PRDetailRecoveryCommitArgs,
  PRDetailRecoverySnapshot,
  PRDetailRecoveryStartArgs,
  PRDetailRecoveryWaitArgs
} from '../../shared/github/pull-requests/refresh/pr-detail-recovery-contract'

export type GithubPullRequestApi = {
  viewer: () => Promise<GitHubViewer | null>
  repoSlug: (args: {
    repoPath: string
    repoId?: string
  }) => Promise<{ owner: string; repo: string; host?: string } | null>
  repoUpstream: (args: {
    repoPath: string
    repoId?: string
  }) => Promise<{ owner: string; repo: string; host?: string } | null>
  prForBranch: (args: {
    repoPath: string
    repoId?: string
    repoOwnerExecutionHostId?: string
    branch: string
    linkedPRNumber?: number | null
    fallbackPRNumber?: number | null
    acceptMergedFallbackPR?: boolean
    currentHeadOid?: string | null
    wakeWslDistro?: boolean
    userRefresh?: boolean
  }) => Promise<PRInfo | null>
  refreshPRNow: (args: {
    candidate: GitHubPRRefreshCandidate
    reason?: GitHubPRRefreshReason
    userRefresh?: boolean
  }) => Promise<PRSnapshotReply>
  enqueuePRRefresh: (args: {
    candidate: GitHubPRRefreshCandidate
    reason: GitHubPRRefreshReason
    priority?: number
  }) => Promise<GitHubPRRefreshEnqueueResult | false>
  reportVisiblePRRefreshCandidates: (args: {
    candidates: GitHubPRRefreshCandidate[]
    generation: number
  }) => Promise<boolean>
  onPRRefreshEvent: (callback: (event: GitHubPRRefreshEvent) => void) => () => void
  /** Absent on web and older preloads: their panels keep manual-only detail recovery. */
  startPRDetailRecovery?: (args: PRDetailRecoveryStartArgs) => Promise<PRDetailRecoverySnapshot>
  waitPRDetailRecovery?: (
    args: PRDetailRecoveryWaitArgs
  ) => Promise<PRDetailRecoverySnapshot | null>
  commitPRDetailRecovery?: (
    args: PRDetailRecoveryCommitArgs
  ) => Promise<PRDetailRecoverySnapshot | null>
  cancelPRDetailRecovery?: (
    args: PRDetailRecoveryCancelArgs
  ) => Promise<PRDetailRecoverySnapshot | null>
  prFileContents: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      prRepo?: GitHubOwnerRepo | null
      path: string
      oldPath?: string
      status: GitHubPRFile['status']
      headSha: string
      baseSha: string
    }
  ) => Promise<GitHubPRFileContents>
  prChecks: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      headSha?: string
      prRepo?: GitHubOwnerRepo | null
      noCache?: boolean
      /** Refresh or a check action: a user act that may start a stopped WSL distro. */
      wakeWslDistro?: boolean
      userRefresh?: boolean
    }
  ) => Promise<PRCheckDetail[]>
  prCheckDetails: (args: {
    repoPath: string
    repoId?: string
    repoOwnerExecutionHostId?: string
    sourceContext?: TaskSourceContext | null
    checkRunId?: number
    workflowRunId?: number
    checkName?: string
    url?: string | null
    prRepo?: GitHubOwnerRepo | null
  }) => Promise<PRCheckRunDetails | null>
  rerunPRChecks: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      headSha?: string
      failedOnly?: boolean
      prRepo?: GitHubOwnerRepo | null
    }
  ) => Promise<{ ok: true; count: number } | { ok: false; error: string }>
  prComments: (args: {
    repoPath: string
    repoId?: string
    repoOwnerExecutionHostId?: string
    sourceContext?: TaskSourceContext | null
    prNumber: number
    prRepo?: GitHubOwnerRepo | null
    noCache?: boolean
  }) => Promise<PRComment[]>
  setPRCommentReaction: (args: {
    repoPath: string
    repoId?: string
    repoOwnerExecutionHostId?: string
    sourceContext?: TaskSourceContext | null
    reactionSubjectId: string
    content: GitHubReactionContent
    reacted: boolean
    prRepo?: GitHubOwnerRepo | null
  }) => Promise<boolean>
  resolveReviewThread: (args: {
    repoPath: string
    repoId?: string
    repoOwnerExecutionHostId?: string
    sourceContext?: TaskSourceContext | null
    threadId: string
    resolve: boolean
    prRepo?: GitHubOwnerRepo | null
  }) => Promise<boolean>
  setPRFileViewed: (
    args: GitHubRepoSelectorArgs & {
      expectedGhAccount?: GhAccountBinding | null
      prNumber: number
      prRepo?: GitHubOwnerRepo | null
      pullRequestId: string
      path: string
      viewed: boolean
    }
  ) => Promise<boolean>
  updatePRTitle: (args: {
    repoPath: string
    repoId?: string
    prNumber: number
    title: string
    prRepo?: GitHubOwnerRepo | null
  }) => Promise<boolean>
  mergePR: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      method?: 'merge' | 'squash' | 'rebase'
      prRepo?: GitHubOwnerRepo | null
    }
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  setPRAutoMerge: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      enabled: boolean
      method?: 'merge' | 'squash' | 'rebase'
      prRepo?: GitHubOwnerRepo | null
    }
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  updatePRState: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      updates: { state: 'open' | 'closed' }
      prRepo?: GitHubOwnerRepo | null
    }
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  markPRReadyForReview: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      prRepo?: GitHubOwnerRepo | null
    }
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  requestPRReviewers: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      reviewers: string[]
      prRepo?: GitHubOwnerRepo | null
    }
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  removePRReviewers: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      reviewers: string[]
      prRepo?: GitHubOwnerRepo | null
    }
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  addPRReviewCommentReply: (
    args: GitHubRepoSelectorArgs & {
      prNumber: number
      commentId: number
      body: string
      threadId?: string
      path?: string
      line?: number
      prRepo?: GitHubOwnerRepo | null
    }
  ) => Promise<GitHubCommentResult>
  addPRReviewComment: (
    args: GitHubPRReviewCommentInput & {
      repoId?: string
      sourceContext?: TaskSourceContext | null
    }
  ) => Promise<GitHubCommentResult>
  checkOrcaStarred: () => Promise<boolean | null>
  starOrca: (source: AppStarSource) => Promise<boolean>
  /** Quota-exempt; cached for 30s unless force is true. */
  rateLimit: (args?: { force?: boolean }) => Promise<GetRateLimitResult>
  /** Detects missing scopes and shell tokens shadowing keyring credentials. */
  diagnoseAuth: (args?: { host?: string }) => Promise<GhAuthDiagnostic>
}
