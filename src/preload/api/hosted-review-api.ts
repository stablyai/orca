import type {
  BitbucketConnectArgs,
  BitbucketConnectionStatus
} from '../../shared/bitbucket-credentials'
import type { BitbucketPRMergeMethod } from '../../shared/bitbucket-merge-methods'
import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  CreateHostedReviewArgs,
  CreateHostedReviewResult,
  CreateStackedHostedReviewArgs,
  CreateStackedHostedReviewResult,
  HostedReviewCreationEligibility,
  HostedReviewCreationEligibilityArgs,
  HostedReviewForBranchArgs,
  HostedReviewInfo
} from '../../shared/hosted-review'

export type HostedReviewApi = {
  forBranch: (args: HostedReviewForBranchArgs) => Promise<HostedReviewInfo | null>
  getCreationEligibility: (
    args: HostedReviewCreationEligibilityArgs
  ) => Promise<HostedReviewCreationEligibility>
  create: (args: CreateHostedReviewArgs) => Promise<CreateHostedReviewResult>
  createStacked: (args: CreateStackedHostedReviewArgs) => Promise<CreateStackedHostedReviewResult>
}

import type { PRComment } from '../../shared/github/comment-types'

export type BitbucketApi = {
  connect: (
    args: BitbucketConnectArgs
  ) => Promise<{ ok: true; account: string | null } | { ok: false; error: string }>
  disconnect: () => Promise<void>
  status: () => Promise<BitbucketConnectionStatus>
  mergePR: (args: {
    repoPath: string
    prNumber: number
    method?: BitbucketPRMergeMethod
    closeSourceBranch?: boolean
    executionHostId?: ExecutionHostId
  }) => Promise<{ ok: true } | { ok: false; error: string }>
  closePR: (args: {
    repoPath: string
    prNumber: number
    executionHostId?: ExecutionHostId
  }) => Promise<{ ok: true } | { ok: false; error: string }>
  getPRComments: (args: {
    repoPath: string
    prNumber: number
    executionHostId?: ExecutionHostId
  }) => Promise<PRComment[]>
  addPRComment: (args: {
    repoPath: string
    prNumber: number
    body: string
    parentId?: number
    rootCommentId?: number
    inline?: { path: string; line: number }
    executionHostId?: ExecutionHostId
  }) => Promise<{ ok: true; comment: PRComment } | { ok: false; error: string }>
  replyPRComment: (args: {
    repoPath: string
    prNumber: number
    parentId: number
    body: string
    rootCommentId?: number
    executionHostId?: ExecutionHostId
  }) => Promise<{ ok: true; comment: PRComment } | { ok: false; error: string }>
}
