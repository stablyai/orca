import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { ghRepoExecOptions } from '../../repositories/github-repository-identity'
import type { GitHubRepositoryIdentity as OwnerRepo } from '../../../../shared/github/repositories/repository-identity'
import { mergedPRHeadMembership } from '../../pull-requests/refresh/merged-pr-head-membership'
import type { MergedReviewCommitMembership as MergedPRCommitMembership } from '../../../source-control/merged-review-membership-memo'
import { shouldHideNonOpenReviewOnDefaultBranch } from '../../../source-control/repo-default-branch'
import { resolveGitHubApiRepositoryCandidates } from '../../repositories/github-api-repository'
import { exactRepositoryCandidates } from '../pull-request-lookup-candidates'
import { mapPRState } from '../../api/github-read-response'
import {
  ownerRepoFromPullRequestUrl,
  type HostedReviewLocalGitOptions
} from './../github-exec-scope'
import { prRefreshUpstreamError } from './../gh-error-predicates'
import {
  isMergedImplicitPR,
  shouldHideMergedImplicitPR,
  getCurrentHeadOid,
  pullRequestHeadRepository,
  linkedMergedPRDivergedHeadOid,
  type PullRequestLookupData,
  type GitHubPRBranchLookupOptions
} from './pull-request-lookup-data'
import { lookupPRByBranchName } from './pr-branch-lookup'
import { lookupPRByNumber } from './pr-number-lookup'
import { derivePRRefreshData } from './branch-lookup-derived-data'
import { assemblePRRefreshFoundOutcome } from './pr-refresh-outcome-assembly'
import { branchHeadKey, getConfiguredPushHead, getTrackedUpstreamHead } from './branch-review-heads'
import {
  createImplicitDefaultBranchPRPolicy,
  type ImplicitDefaultBranchPRContext
} from './implicit-default-branch-pr'

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
  const resolved = await resolveGitHubApiRepositoryCandidates(
    repoPath,
    connectionId,
    localGitOptions
  )
  const { headRepo } = resolved
  const candidates = exactRepositoryCandidates(resolved.candidates, options.exactRepository)
  const reads = { checkPageLimit: options.checkPageLimit, userRefresh: options.userRefresh }
  // Without local cwd, unresolved connection-backed lookups could follow ambient GH_REPO/GH_HOST.
  if (connectionId && candidates.length === 0) {
    return { kind: 'no-pr', fetchedAt: Date.now() }
  }
  let data: PullRequestLookupData | null = null
  let dataRepo: OwnerRepo | null = null
  let dataHeadRepo: OwnerRepo | null = headRepo
  let pendingBranchLookupError: unknown
  let hasPendingBranchLookupError = false
  let currentHeadOidForMergedImplicit: string | null | undefined
  let usedExactNumberLookup = false
  const defaultBranchPRContext: ImplicitDefaultBranchPRContext = {
    originHeadRepo: headRepo,
    secondaryHeads: [],
    branchName,
    linkedPRNumber,
    repoPath,
    connectionId,
    localGitOptions,
    ghOptions
  }
  const implicitPRPolicy = createImplicitDefaultBranchPRPolicy(defaultBranchPRContext)

  const explicitCurrentHeadOid =
    typeof options.currentHeadOid === 'string' && options.currentHeadOid.trim().length > 0
      ? options.currentHeadOid.trim()
      : null
  let confirmedContainedHeadOid: string | null = null
  const mergedPRContainsHead = async (
    candidate: PullRequestLookupData,
    candidateRepo: OwnerRepo | null,
    headOid: string | null
  ): Promise<MergedPRCommitMembership> => {
    if (!candidateRepo || !headOid) {
      return 'unknown'
    }
    const membership = await mergedPRHeadMembership({
      ownerRepo: candidateRepo,
      prNumber: candidate.number,
      prHeadOid: candidate.headRefOid,
      baseRefName: candidate.baseRefName,
      headOid,
      ghOptions,
      repoPath,
      connectionId,
      localGitOptions
    })
    if (membership === 'contained') {
      confirmedContainedHeadOid = headOid
    }
    return membership
  }
  const hideMergedImplicitPR = async (
    candidate: PullRequestLookupData | null,
    candidateRepo: OwnerRepo | null
  ) => {
    if (!candidate || !isMergedImplicitPR(candidate, linkedPRNumber)) {
      return false
    }
    // Prefer the actual worktree head; main-repo HEAD can differ for secondary worktrees.
    currentHeadOidForMergedImplicit ??=
      explicitCurrentHeadOid !== null
        ? explicitCurrentHeadOid
        : await getCurrentHeadOid(repoPath, connectionId, localGitOptions)
    if (!shouldHideMergedImplicitPR(candidate, linkedPRNumber, currentHeadOidForMergedImplicit)) {
      return false
    }
    // PR-history membership preserves merged work after web commits or update-branch merges.
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
      executionScope,
      reads
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
      executionScope,
      policy: implicitPRPolicy,
      reads
    })
    data = branchLookup.data
    dataRepo = branchLookup.dataRepo
    if ('pendingError' in branchLookup) {
      pendingBranchLookupError = branchLookup.pendingError
      hasPendingBranchLookupError = true
    }
    // Tracked upstream, then the configured push head, disambiguate head branch and fork owner.
    const triedHeads = new Set(headRepo ? [branchHeadKey(headRepo, branchName)] : [])
    const secondaryHeads = [
      () => getTrackedUpstreamHead(repoPath, branchName, connectionId, localGitOptions, headRepo),
      () => getConfiguredPushHead(repoPath, branchName, connectionId, localGitOptions)
    ]
    for (const resolveHead of secondaryHeads) {
      const head = data ? null : await resolveHead()
      const key = head ? branchHeadKey(head.headRepo, head.branch.branchName) : null
      if (!head || !key || triedHeads.has(key)) {
        continue
      }
      triedHeads.add(key)
      defaultBranchPRContext.secondaryHeads.push(head)
      const headLookup = await lookupPRByBranchName({
        candidates,
        headRepo: head.headRepo,
        branchName: head.branch.branchName,
        ghOptions,
        executionScope,
        policy: implicitPRPolicy,
        reads
      })
      data = headLookup.data
      dataRepo = headLookup.dataRepo
      if (!hasPendingBranchLookupError && 'pendingError' in headLookup) {
        pendingBranchLookupError = headLookup.pendingError
        hasPendingBranchLookupError = true
      }
      if (data) {
        dataHeadRepo = head.headRepo
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
      executionScope,
      policy: implicitPRPolicy,
      reads
    })
    data = fallbackLookup.data
    dataRepo = fallbackLookup.dataRepo
  }
  if (!data) {
    if (hasPendingBranchLookupError) {
      return prRefreshUpstreamError(pendingBranchLookupError)
    }
    return {
      kind: 'no-pr',
      fetchedAt: Date.now(),
      ...(implicitPRPolicy.rejectedPRUrls.size > 0
        ? { rejectedPRUrls: [...implicitPRPolicy.rejectedPRUrls] }
        : {})
    }
  }
  dataHeadRepo = pullRequestHeadRepository(data, dataRepo) ?? dataHeadRepo
  const headDivergedFromMergedPRAtOid = await linkedMergedPRDivergedHeadOid(
    data,
    linkedPRNumber,
    explicitCurrentHeadOid,
    (candidate, headOid) =>
      mergedPRContainsHead(
        candidate,
        dataRepo ?? ownerRepoFromPullRequestUrl(candidate.url),
        headOid
      )
  )
  const fallbackConfirmedMergedBranch =
    typeof fallbackPRNumber === 'number' &&
    mergedBranchLookupNumber === fallbackPRNumber &&
    data.number === fallbackPRNumber
  const explicitHeadHidesMergedImplicitPR =
    explicitCurrentHeadOid !== null &&
    shouldHideMergedImplicitPR(data, linkedPRNumber, explicitCurrentHeadOid) &&
    (await mergedPRContainsHead(data, dataRepo, explicitCurrentHeadOid)) !== 'contained'
  // Fallback preservation already checked head identity; repeating lazy-HEAD checks could hide valid deleted heads.
  const shouldPreserveMergedFallback =
    !explicitHeadHidesMergedImplicitPR &&
    (fallbackConfirmedMergedBranch || options.acceptMergedFallbackPR === true)
  // Refresh caller-preserved fallbacks after external merges or head-branch deletion.
  if ((await hideMergedImplicitPR(data, dataRepo)) && !shouldPreserveMergedFallback) {
    return { kind: 'no-pr', fetchedAt: Date.now() }
  }
  // Default-branch non-open matches stay hidden even at merged HEAD; exact linked lookups remain exempt.
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
    usedExactNumberLookup,
    includeDerivedData: options.includeDerivedData
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
