import type { PRRefreshOutcome } from '../../../../shared/github/pull-request-refresh-types'
import type { ghRepoExecOptions, OwnerRepo } from '../../gh-utils'
import {
  isCommitPartOfMergedPR,
  type MergedPRCommitMembership
} from '../../merged-pr-commit-membership'
import { shouldHideNonOpenReviewOnDefaultBranch } from '../../../source-control/repo-default-branch'
import {
  getGitHubApiRepositoryForRemote,
  resolveGitHubApiRepositoryCandidates
} from '../../github-api-repository'
import { mapPRState } from '../../mappers'
import { noteRepositoryRateLimitSpend } from '../../rate-limit'
import { ownerRepoFromPullRequestUrl } from './../github-exec-scope'
import { prRefreshUpstreamError } from './../gh-error-predicates'
import {
  isMergedImplicitPR,
  shouldHideMergedImplicitPR,
  getCurrentHeadOid,
  type PullRequestLookupData,
  type GitHubPRBranchLookupOptions
} from './pull-request-lookup-data'
import { lookupPRByBranchName } from './pr-branch-lookup'
import { lookupPRByNumber } from './pr-number-lookup'
import { derivePRRefreshData } from './branch-lookup-derived-data'
import { assemblePRRefreshFoundOutcome } from './pr-refresh-outcome-assembly'
import { shouldRetryTrackedUpstreamBranch } from './tracked-upstream-cache'
import { getTrackedUpstreamBranch } from './tracked-upstream-branch'
import { PR_BRANCH_LOOKUP_BUCKETS } from './pr-lookup-rate-limit'
import type { HostedReviewLocalGitOptions } from './../github-exec-scope'
export async function resolvePRForBranchOutcome(input: {
  repoPath: string
  branchName: string
  linkedPRNumber?: number | null
  connectionId?: string | null
  fallbackPRNumber?: number | null
  options: GitHubPRBranchLookupOptions
  localGitOptions: HostedReviewLocalGitOptions
  ghOptions: ReturnType<typeof ghRepoExecOptions>
  executionScope: string
}): Promise<PRRefreshOutcome> {
  const {
    repoPath,
    branchName,
    linkedPRNumber,
    connectionId,
    fallbackPRNumber,
    options,
    localGitOptions,
    ghOptions,
    executionScope
  } = input
  const { candidates, headRepo } = await resolveGitHubApiRepositoryCandidates(
    repoPath,
    connectionId,
    localGitOptions,
    branchName
  )
  // Why: connection-backed gh runs without a repository cwd. A bare lookup
  // here can honor process GH_REPO/GH_HOST and return an unrelated PR.
  if (connectionId && candidates.length === 0) {
    return { kind: 'no-pr', fetchedAt: Date.now() }
  }
  // Why (#11532): account every lookup, not just the coordinator's queue —
  // `hostedReview:forBranch` reaches this directly from renderer polling and
  // was spending the shared quota invisibly. headRepo is `origin`, the same
  // identity the coordinator guards on.
  for (const bucket of PR_BRANCH_LOOKUP_BUCKETS) {
    noteRepositoryRateLimitSpend(headRepo ?? candidates[0], bucket, 1, ghOptions)
  }
  let data: PullRequestLookupData | null = null
  let dataRepo: OwnerRepo | null = null
  let dataHeadRepo: OwnerRepo | null = headRepo
  let pendingBranchLookupError: unknown
  let hasPendingBranchLookupError = false
  let currentHeadOidForMergedImplicit: string | null | undefined
  let usedExactNumberLookup = false

  const explicitCurrentHeadOid =
    typeof options.currentHeadOid === 'string' && options.currentHeadOid.trim().length > 0
      ? options.currentHeadOid.trim()
      : null
  let confirmedContainedHeadOid: string | null = null
  let headDivergedFromMergedPRAtOid: string | null = null
  const mergedPRContainsHead = async (
    candidate: PullRequestLookupData,
    candidateRepo: OwnerRepo | null,
    headOid: string | null
  ): Promise<MergedPRCommitMembership> => {
    if (!candidateRepo || !headOid) {
      return 'unknown'
    }
    const membership = await isCommitPartOfMergedPR({
      ownerRepo: candidateRepo,
      prNumber: candidate.number,
      commitOid: headOid,
      ghOptions
    })
    if (membership === 'contained') {
      confirmedContainedHeadOid = headOid
    }
    return membership
  }
  const recordLinkedMergedPRDivergence = async (
    candidate: PullRequestLookupData | null,
    candidateRepo: OwnerRepo | null
  ): Promise<void> => {
    if (
      typeof linkedPRNumber !== 'number' ||
      !candidate ||
      mapPRState(candidate.state, candidate.isDraft) !== 'merged' ||
      explicitCurrentHeadOid === null ||
      candidate.headRefOid === explicitCurrentHeadOid
    ) {
      return
    }
    const membership = await mergedPRContainsHead(
      candidate,
      candidateRepo ?? ownerRepoFromPullRequestUrl(candidate.url),
      explicitCurrentHeadOid
    )
    if (membership === 'not-contained') {
      // explicitCurrentHeadOid is non-null here (guarded above); record the exact diverged head so consumers clear only that worktree.
      headDivergedFromMergedPRAtOid = explicitCurrentHeadOid
    }
  }
  const hideMergedImplicitPR = async (
    candidate: PullRequestLookupData | null,
    candidateRepo: OwnerRepo | null
  ) => {
    if (!candidate || !isMergedImplicitPR(candidate, linkedPRNumber)) {
      return false
    }
    // Why: prefer the caller's worktree HEAD; only shell out (main repo path) when no explicit oid, keeping merged-at-head PRs visible for secondary worktrees.
    currentHeadOidForMergedImplicit ??=
      explicitCurrentHeadOid !== null
        ? explicitCurrentHeadOid
        : await getCurrentHeadOid(repoPath, connectionId, localGitOptions)
    if (!shouldHideMergedImplicitPR(candidate, linkedPRNumber, currentHeadOidForMergedImplicit)) {
      return false
    }
    // Why: a head that is one of the PR's own commits (update-branch/web commits) is the same work, not a reused branch name — keep the merged PR visible.
    return (
      (await mergedPRContainsHead(candidate, candidateRepo, currentHeadOidForMergedImplicit)) !==
      'contained'
    )
  }

  if (typeof linkedPRNumber === 'number') {
    usedExactNumberLookup = true
    const exactLookup = await lookupPRByNumber({
      candidates,
      number: linkedPRNumber,
      ghOptions,
      executionScope
    })
    data = exactLookup.data
    dataRepo = exactLookup.dataRepo
  } else if (branchName) {
    // During a rebase (detached HEAD) branch is empty; an empty --head filter makes gh return an arbitrary PR.
    const branchLookup = await lookupPRByBranchName({
      candidates,
      headRepo,
      branchName,
      ghOptions,
      executionScope
    })
    data = branchLookup.data
    dataRepo = branchLookup.dataRepo
    if ('pendingError' in branchLookup) {
      pendingBranchLookupError = branchLookup.pendingError
      hasPendingBranchLookupError = true
    }
    if (!data) {
      // Why: the tracked upstream identifies the real PR head by branch name or fork owner even when local branch names match.
      const upstreamBranch = await getTrackedUpstreamBranch(
        repoPath,
        branchName,
        connectionId,
        localGitOptions
      )
      if (upstreamBranch) {
        const upstreamHeadRepo =
          (await getGitHubApiRepositoryForRemote(
            repoPath,
            upstreamBranch.remoteName,
            connectionId,
            localGitOptions
          )) ?? headRepo
        if (
          upstreamHeadRepo &&
          shouldRetryTrackedUpstreamBranch(upstreamBranch, branchName, upstreamHeadRepo, headRepo)
        ) {
          const upstreamLookup = await lookupPRByBranchName({
            candidates,
            headRepo: upstreamHeadRepo,
            branchName: upstreamBranch.branchName,
            ghOptions,
            executionScope
          })
          data = upstreamLookup.data
          dataRepo = upstreamLookup.dataRepo
          if (!hasPendingBranchLookupError && 'pendingError' in upstreamLookup) {
            pendingBranchLookupError = upstreamLookup.pendingError
            hasPendingBranchLookupError = true
          }
          if (data) {
            dataHeadRepo = upstreamHeadRepo
          }
        }
      }
    }
  }
  let mergedBranchLookupNumber: number | null = null
  if (await hideMergedImplicitPR(data, dataRepo)) {
    mergedBranchLookupNumber = data?.number ?? null
    data = null
    dataRepo = null
    dataHeadRepo = headRepo
  }
  if (!data && typeof linkedPRNumber !== 'number' && typeof fallbackPRNumber === 'number') {
    usedExactNumberLookup = true
    const fallbackLookup = await lookupPRByNumber({
      candidates,
      number: fallbackPRNumber,
      ghOptions,
      executionScope
    })
    data = fallbackLookup.data
    dataRepo = fallbackLookup.dataRepo
  }
  if (!data) {
    if (hasPendingBranchLookupError) {
      return prRefreshUpstreamError(pendingBranchLookupError)
    }
    return { kind: 'no-pr', fetchedAt: Date.now() }
  }
  await recordLinkedMergedPRDivergence(data, dataRepo)
  const fallbackConfirmedMergedBranch =
    typeof fallbackPRNumber === 'number' &&
    mergedBranchLookupNumber === fallbackPRNumber &&
    data.number === fallbackPRNumber
  const explicitHeadHidesMergedImplicitPR =
    explicitCurrentHeadOid !== null &&
    shouldHideMergedImplicitPR(data, linkedPRNumber, explicitCurrentHeadOid) &&
    (await mergedPRContainsHead(data, dataRepo, explicitCurrentHeadOid)) !== 'contained'
  // Why no lazy-HEAD re-check: fallback numbers were already gated on head equality/containment; re-hiding would blank kept deleted-head merged PRs.
  const shouldPreserveMergedFallback =
    !explicitHeadHidesMergedImplicitPR &&
    (fallbackConfirmedMergedBranch || options.acceptMergedFallbackPR === true)
  // Why: a visible PR can be merged outside Orca; keep a caller-marked fallback fresh even when GitHub no longer reports it by branch (e.g. deleted heads).
  if ((await hideMergedImplicitPR(data, dataRepo)) && !shouldPreserveMergedFallback) {
    return { kind: 'no-pr', fetchedAt: Date.now() }
  }
  // Why (#9171): on the default branch an implicit branch/fallback match must
  // never surface a non-open PR — it overrides the merged-fallback
  // preservation and merged-at-head carve-out on the trunk only. An exact
  // linked lookup returns the linked number, so linked PRs are exempt.
  if (
    await shouldHideNonOpenReviewOnDefaultBranch({
      state: mapPRState(data.state, data.isDraft),
      reviewNumber: data.number,
      linkedReviewNumber: linkedPRNumber,
      branchName,
      repoPath,
      connectionId,
      localGitOptions
    })
  ) {
    return { kind: 'no-pr', fetchedAt: Date.now() }
  }

  const { mergeable, stack, stackMergeQueueRequired, conflictSummary } = await derivePRRefreshData({
    data,
    dataRepo,
    repoPath,
    connectionId,
    localGitOptions,
    ghOptions,
    executionScope,
    usedExactNumberLookup
  })

  return assemblePRRefreshFoundOutcome({
    data,
    dataRepo,
    dataHeadRepo,
    stack,
    mergeable,
    stackMergeQueueRequired,
    confirmedContainedHeadOid,
    headDivergedFromMergedPRAtOid,
    conflictSummary
  })
}
