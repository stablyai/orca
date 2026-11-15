import type { ExecutionHostId } from '../../shared/execution-host'
import type { HostedReviewInfo } from '../../shared/source-control/hosted-review/hosted-review-contracts'

export type CacheEntry = {
  review: HostedReviewInfo | null
  fetchedAt: number
  headOid: string | null
  /** When the lookup that produced this answer began, for straggler ordering. */
  startedAt: number
}

export type HostedReviewBranchCacheIdentity = {
  repoPath: string
  executionHostId: ExecutionHostId
  branch: string
  linkedGitHubPR?: number | null
  fallbackGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
  localGitExecOptions?: unknown
}

export type HostedReviewBranchCacheOptions = {
  /** The worktree's checked-out HEAD oid, for merged-at-head visibility. */
  headOid: string | null
  /** Set by surfaces that only ever render the selected worktree. */
  active?: boolean
  force?: boolean
  userRefresh?: boolean
}
