import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  CreateHostedReviewInput,
  CreateHostedReviewResult,
  HostedReviewCreationEligibility,
  HostedReviewCreationEligibilityArgs,
  HostedReviewLookupOutcome
} from '../../shared/hosted-review'
import { supportsHostedReviewCreation } from '../../shared/hosted-review-creation-providers'
import { normalizeHostedReviewBaseRef } from '../../shared/hosted-review-refs'
import { getRepoSlug } from '../github/client'
import { isDefaultGitHubHost } from '../../shared/github/repository-identity-key'
import { detectHostedReviewProvider, getForgeProviderForRepository } from './forge-provider'
import { invalidateHostedReviewBranchCache } from './hosted-review-branch-cache'
import { getHostedReviewForBranch } from './hosted-review'
import { blockedEligibilityToCreateResult } from './hosted-review-creation-blocking'
import {
  baseRefExistsOnRemote,
  getCurrentBranch,
  getDefaultBaseRef,
  getHostedReviewUpstreamStatus,
  hasUncommittedChanges,
  hostedReviewExecutionContext,
  stripRefPrefix
} from './hosted-review-creation-git-state'
import { isProviderAuthenticated, reviewCopy } from './hosted-review-creation-provider'
import { hostedReviewSshConnectionId } from './hosted-review-execution-host'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from './hosted-review-git-options'

// Ignore legacy wire connectionId; only the resolved execution host authorizes routing.
type HostedReviewCreationEligibilityInput = Omit<
  HostedReviewCreationEligibilityArgs,
  'connectionId'
> & {
  executionHostId: ExecutionHostId
  // Create enforces submitted base; renderer preview may correct a local-only parent.
  enforceBaseOnRemote?: boolean
} & HostedReviewExecutionOptions

async function validateCurrentBranchCanCreateReview(
  repoPath: string,
  executionHostId: ExecutionHostId,
  input: CreateHostedReviewInput,
  options: HostedReviewExecutionOptions = {}
): Promise<CreateHostedReviewResult | null> {
  const requestedHead = input.head ? stripRefPrefix(input.head).trim() : ''
  const currentBranch = await getCurrentBranch(repoPath, executionHostId, options)
  const copy = reviewCopy(input.provider)
  if (requestedHead && requestedHead !== currentBranch) {
    return {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: switch back to the selected branch before creating a ${copy.reviewLabel}.`,
      reason: 'branch_changed'
    }
  }

  try {
    const [dirty, upstreamStatus] = await Promise.all([
      hasUncommittedChanges(repoPath, executionHostId, options),
      getHostedReviewUpstreamStatus(repoPath, executionHostId, options)
    ])
    const submittedBase = normalizeHostedReviewBaseRef(input.base)
    const eligibility = await getHostedReviewCreationEligibility({
      repoPath,
      branch: requestedHead || currentBranch,
      base: submittedBase,
      hasUncommittedChanges: dirty,
      hasUpstream: upstreamStatus.hasUpstream,
      ahead: upstreamStatus.ahead,
      behind: upstreamStatus.behind,
      executionHostId,
      // Providers use submitted base verbatim; recheck remote resolvability at creation.
      enforceBaseOnRemote: true,
      ...options
    })
    // Unavailable lookup can hide a real review; refuse duplicate creation (invariant 8).
    if (eligibility.reviewLookupOutcome === 'unavailable') {
      return {
        ok: false,
        code: 'validation',
        error: `Create ${copy.shortLabel} failed: Orca could not confirm whether this branch already has a ${copy.reviewLabel}. Retry once the ${copy.providerName} lookup succeeds.`,
        reason: 'review_lookup_unavailable'
      }
    }
    // Recheck stale renderer eligibility in main before submission.
    return blockedEligibilityToCreateResult(eligibility, submittedBase)
  } catch (error) {
    console.warn('Hosted review creation preflight failed:', error)
    return {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: could not verify branch status. Refresh source control and try again.`,
      reason: 'branch_status_unverified'
    }
  }
}

export async function getHostedReviewCreationEligibility(
  args: HostedReviewCreationEligibilityInput
): Promise<HostedReviewCreationEligibility> {
  const branch = stripRefPrefix(args.branch).trim()
  const provider = await detectHostedReviewProvider({
    repoPath: args.repoPath,
    executionHostId: args.executionHostId,
    ...hostedReviewExecutionContext(args)
  })
  // Preview may replace a local-only parent candidate with a remotely resolvable default.
  const candidateBase = args.base?.trim() || null
  const candidateBaseOnRemote =
    candidateBase != null &&
    (await baseRefExistsOnRemote(candidateBase, args.repoPath, args.executionHostId, args))
  let defaultBaseRef: string | null
  if (candidateBase && candidateBaseOnRemote) {
    defaultBaseRef = candidateBase
  } else {
    const repoDefaultBaseRef = await getDefaultBaseRef(args.repoPath, args.executionHostId, args)
    defaultBaseRef = repoDefaultBaseRef ?? candidateBase
  }
  const baseBranch = defaultBaseRef ? normalizeHostedReviewBaseRef(defaultBaseRef) : null
  let review: Awaited<ReturnType<typeof getHostedReviewForBranch>> = null
  // Preserve lookup uncertainty separately from authoritative absence.
  let lookupFailed = false
  try {
    review = await getHostedReviewForBranch({
      repoPath: args.repoPath,
      branch,
      linkedGitHubPR: args.linkedGitHubPR ?? null,
      fallbackGitHubPR: args.linkedGitHubPR == null ? (args.fallbackGitHubPR ?? null) : null,
      linkedGitLabMR: args.linkedGitLabMR ?? null,
      linkedBitbucketPR: args.linkedBitbucketPR ?? null,
      linkedAzureDevOpsPR: args.linkedAzureDevOpsPR ?? null,
      linkedGiteaPR: args.linkedGiteaPR ?? null,
      executionHostId: args.executionHostId,
      // The acted-on worktree earns active pacing so external review creation promptly blocks duplicates (#11532).
      active: true,
      ...hostedReviewExecutionContext(args)
    })
  } catch (error) {
    // Record unavailable and continue eligibility; do not turn failed lookup into no review.
    lookupFailed = true
    console.warn('Hosted review lookup failed; treating existing-review as unavailable:', error)
  }

  const reviewLookupOutcome: HostedReviewLookupOutcome = review
    ? 'found'
    : lookupFailed
      ? 'unavailable'
      : 'not_found'
  const githubRepository =
    provider === 'github'
      ? await getRepoSlug(
          args.repoPath,
          hostedReviewSshConnectionId(args.executionHostId),
          args
        ).catch(() => null)
      : null
  const baseResult = {
    provider,
    review: review ? { number: review.number, url: review.url } : null,
    reviewLookupOutcome,
    defaultBaseRef,
    head: branch || null,
    ...(githubRepository && isDefaultGitHubHost(githubRepository.host)
      ? { stackedCreationSupported: true }
      : {})
  }

  if (!branch || branch === 'HEAD') {
    return { ...baseResult, canCreate: false, blockedReason: 'detached_head', nextAction: null }
  }
  if (review) {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: 'existing_review',
      nextAction: 'open_existing_review'
    }
  }
  if (!supportsHostedReviewCreation(provider)) {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: 'unsupported_provider',
      nextAction: null
    }
  }
  if (baseBranch && branch.toLowerCase() === baseBranch.toLowerCase()) {
    return { ...baseResult, canCreate: false, blockedReason: 'default_branch', nextAction: null }
  }
  if (args.hasUncommittedChanges) {
    return { ...baseResult, canCreate: false, blockedReason: 'dirty', nextAction: 'commit' }
  }
  if (args.hasUpstream === false) {
    return { ...baseResult, canCreate: false, blockedReason: 'no_upstream', nextAction: 'publish' }
  }
  if (args.hasUpstream !== true) {
    return { ...baseResult, canCreate: false, blockedReason: null, nextAction: null }
  }
  if ((args.behind ?? 0) > 0) {
    return { ...baseResult, canCreate: false, blockedReason: 'needs_sync', nextAction: 'sync' }
  }
  const authenticated = await isProviderAuthenticated(
    provider,
    args.repoPath,
    args.executionHostId,
    args
  )
  if (!authenticated) {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: 'auth_required',
      nextAction: 'authenticate'
    }
  }
  if ((args.ahead ?? 0) > 0) {
    return { ...baseResult, canCreate: false, blockedReason: 'needs_push', nextAction: 'push' }
  }
  // Block local-only submitted bases because providers use them verbatim.
  if (args.enforceBaseOnRemote && candidateBase && !candidateBaseOnRemote) {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: 'base_not_on_remote',
      nextAction: null
    }
  }
  // Unknown review existence cannot authorize Create.
  return {
    ...baseResult,
    canCreate: lookupFailed ? false : Boolean(baseBranch),
    blockedReason: null,
    nextAction: null
  }
}

/** Consistent refusal for provider types this build cannot create. */
export const UNSUPPORTED_HOSTED_REVIEW_PROVIDER: CreateHostedReviewResult = {
  ok: false,
  code: 'unsupported_provider',
  error: 'Creating reviews for this provider is not supported yet.',
  reason: 'provider_not_supported'
}

export async function createHostedReview(
  repoPath: string,
  input: CreateHostedReviewInput,
  executionHostId: ExecutionHostId,
  options: HostedReviewExecutionOptions = {}
): Promise<CreateHostedReviewResult> {
  if (!supportsHostedReviewCreation(input.provider)) {
    return UNSUPPORTED_HOSTED_REVIEW_PROVIDER
  }
  const provider = await getForgeProviderForRepository({
    repoPath,
    executionHostId,
    ...hostedReviewExecutionContext(options)
  })
  if (provider?.id !== input.provider || !provider.createReview) {
    const copy = reviewCopy(input.provider)
    return {
      ok: false,
      code: 'unsupported_provider',
      error: `Creating ${copy.reviewLabel}s requires a ${copy.providerName} remote.`,
      reason: 'unsupported_provider'
    }
  }
  const blocked = await validateCurrentBranchCanCreateReview(
    repoPath,
    executionHostId,
    input,
    options
  )
  if (blocked) {
    return blocked
  }
  const localGitOptions = getHostedReviewLocalGitOptions(options)
  const result =
    Object.keys(localGitOptions).length > 0
      ? await provider.createReview(repoPath, input, executionHostId, options)
      : await provider.createReview(repoPath, input, executionHostId)
  if (result.ok) {
    // Retire long-lived negative answers immediately after Orca creates a review (#11532).
    invalidateHostedReviewBranchCache(repoPath, executionHostId)
  }
  return result
}
