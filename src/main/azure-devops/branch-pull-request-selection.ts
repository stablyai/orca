import {
  mapAzureDevOpsPullRequestState,
  type RawAzureDevOpsPullRequest
} from './pull-request-mappers'
import type { AzureDevOpsRepoRef } from './repository-ref'
import { requestAzureDevOpsJson } from './azure-devops-api-request'
import type {
  HostedReviewExecutionOptions,
  HostedReviewLocalGitOptions
} from '../source-control/hosted-review-git-options'
import { selectBranchReview } from '../source-control/branch-review-selection'
import { readCurrentReviewHead } from '../source-control/review-current-head'
import {
  COMMIT_ID_SET_RETENTION,
  MergedReviewMembershipMemo
} from '../source-control/merged-review-membership-memo'
import { mergedReviewHeadIsEquivalent } from '../source-control/merged-review-head-equivalence'

function sortPullRequestsForBranch(
  left: RawAzureDevOpsPullRequest,
  right: RawAzureDevOpsPullRequest
): number {
  const leftStatus = left.status?.trim().toLowerCase()
  const rightStatus = right.status?.trim().toLowerCase()
  const abandonedOrder = Number(leftStatus === 'abandoned') - Number(rightStatus === 'abandoned')
  // Newer abandoned PRs must not hide usable branch reviews.
  if (abandonedOrder !== 0) {
    return abandonedOrder
  }
  const leftTime = Date.parse(left.closedDate ?? left.creationDate ?? '') || 0
  const rightTime = Date.parse(right.closedDate ?? right.creationDate ?? '') || 0
  if (leftTime !== rightTime) {
    return rightTime - leftTime
  }
  return Number(rightStatus === 'active') - Number(leftStatus === 'active')
}

export const BRANCH_PULL_REQUEST_PAGE_SIZE = 10

export type AzureDevOpsBranchLookupOptions = HostedReviewExecutionOptions & {
  // The inspected checkout HEAD scopes implicit completed-PR visibility.
  currentHeadOid?: string | null
  userRefresh?: boolean
}

const commitIdsMemo = new MergedReviewMembershipMemo(COMMIT_ID_SET_RETENTION)
// The rebase proof spawns several git processes; polling must not repeat it for an unchanged key.
const rebaseProofMemo = new MergedReviewMembershipMemo<boolean>({
  weight: () => 1,
  maxWeight: 200,
  ttl: () => 6 * 60 * 60_000
})
const COMMITS_PAGE_SIZE = 500
const COMMITS_MAX_PAGES = 10
type RawCommit = { commitId?: string | null }

async function readPullRequestCommitIds(
  repo: AzureDevOpsRepoRef,
  commitsPath: string
): Promise<ReadonlySet<string>> {
  const ids = new Set<string>()
  // A property, not a local, so control flow keeps the token the response callback writes.
  const cursor: { continuationToken: string | null } = { continuationToken: null }
  for (let page = 0; page < COMMITS_MAX_PAGES; page += 1) {
    const raw = await requestAzureDevOpsJson<{ value?: RawCommit[] }>(
      repo,
      commitsPath,
      {
        searchParams: {
          $top: COMMITS_PAGE_SIZE,
          ...(cursor.continuationToken ? { continuationToken: cursor.continuationToken } : {})
        },
        onResponse: (response) => {
          cursor.continuationToken = response.headers.get('x-ms-continuationtoken')
        }
      },
      true
    )
    const commits = raw?.value
    if (!Array.isArray(commits)) {
      throw new Error('Invalid Azure DevOps pull request commits')
    }
    for (const commit of commits) {
      const id = commit?.commitId?.trim().toLowerCase()
      if (id) {
        ids.add(id)
      }
    }
    if (!cursor.continuationToken) {
      break
    }
  }
  // Past the cap the set only proves membership; a HEAD outside it still needs the rebase proof.
  return ids
}

/** A completed PR from an earlier use of a reused branch name is history, not this branch's review. */
export async function isStaleCompletedPullRequest(args: {
  raw: RawAzureDevOpsPullRequest
  linkedPRNumber: number | null | undefined
  repo: AzureDevOpsRepoRef
  pullRequestsPath: string
  repoPath: string
  connectionId?: string | null
  localGitOptions: HostedReviewLocalGitOptions
  currentHeadOid?: string | null
  userRefresh?: boolean
}): Promise<boolean> {
  const { raw } = args
  if (mapAzureDevOpsPullRequestState(raw) !== 'merged' || typeof args.linkedPRNumber === 'number') {
    return false
  }
  if (typeof raw.pullRequestId !== 'number') {
    return true
  }
  const reviewHead = raw.lastMergeSourceCommit?.commitId?.trim() || null
  const currentHead =
    args.currentHeadOid?.trim() ||
    (await readCurrentReviewHead(args.repoPath, args.connectionId, args.localGitOptions))
  // An unreadable HEAD proves nothing; keep the completed PR rather than report no review.
  if (!currentHead) {
    return false
  }
  if (!reviewHead) {
    return true
  }
  if (reviewHead === currentHead) {
    return false
  }
  // A checkout behind the completed PR (web-applied suggestion, push from another clone) is still this review.
  const commitsPath = `${args.pullRequestsPath}/${raw.pullRequestId}/commits`
  const commitIds = await commitIdsMemo
    .read(
      JSON.stringify([args.repo.apiBaseUrl, commitsPath, reviewHead]),
      () => readPullRequestCommitIds(args.repo, commitsPath),
      { refreshFailed: args.userRefresh }
    )
    // A transient commits failure keeps the PR, so it cannot refuse Create PR for the failure TTL.
    .catch(() => null)
  if (!commitIds || commitIds.has(currentHead.toLowerCase())) {
    return false
  }
  // A local rebase mints a SHA Azure DevOps never saw; prove it adds nothing beyond the completed PR.
  const isEquivalentRebase = await rebaseProofMemo.read(
    JSON.stringify([
      args.connectionId ?? null,
      args.localGitOptions.wslDistro ?? null,
      args.repoPath,
      reviewHead,
      currentHead,
      raw.targetRefName ?? null
    ]),
    () =>
      mergedReviewHeadIsEquivalent({
        repoPath: args.repoPath,
        connectionId: args.connectionId,
        localGitOptions: args.localGitOptions,
        reviewHeadOid: reviewHead,
        baseBranchName: raw.targetRefName?.replace(/^refs\/heads\//, ''),
        headOid: currentHead
      }),
    { bypass: args.userRefresh }
  )
  return !isEquivalentRebase
}

/** Active PRs win; a full mixed page cannot prove no older active PR exists, so ask for one. */
export function selectAzureDevOpsBranchPullRequest(
  listPage: (status: 'all' | 'active') => Promise<RawAzureDevOpsPullRequest[]>
): Promise<RawAzureDevOpsPullRequest | null> {
  return selectBranchReview({
    readRecent: async () => (await listPage('all')).sort(sortPullRequestsForBranch),
    readActive: async () => (await listPage('active')).sort(sortPullRequestsForBranch)[0] ?? null,
    isActive: (pr) => pr.status?.trim().toLowerCase() === 'active',
    pageSize: BRANCH_PULL_REQUEST_PAGE_SIZE
  })
}
