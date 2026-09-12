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

// `connectionId` is dropped rather than carried: the wire arg still declares it for older peers,
// but nothing on this side may read it — the resolved host is the only routing answer here.
type HostedReviewCreationEligibilityInput = Omit<
  HostedReviewCreationEligibilityArgs,
  'connectionId'
> & {
  executionHostId: ExecutionHostId
  // Why: only the create-time preflight sets this; the renderer's probe leaves it unset to auto-correct a local-only parent.
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
      error: `Create ${copy.shortLabel} failed: switch back to the selected branch before creating a ${copy.reviewLabel}.`
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
      // Why: last gate before the create, which targets the submitted base verbatim — enforce it exists on the remote.
      enforceBaseOnRemote: true,
      ...options
    })
    // Why: an unavailable lookup might hide a real PR — refuse rather than risk a duplicate (design invariant 8).
    if (eligibility.reviewLookupOutcome === 'unavailable') {
      return {
        ok: false,
        code: 'validation',
        error: `Create ${copy.shortLabel} failed: Orca could not confirm whether this branch already has a ${copy.reviewLabel}. Retry once the ${copy.providerName} lookup succeeds.`
      }
    }
    // Why: renderer eligibility can be stale by submit time; main process is the last gate before an out-of-date create.
    return blockedEligibilityToCreateResult(eligibility, submittedBase)
  } catch (error) {
    console.warn('Hosted review creation preflight failed:', error)
    return {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: could not verify branch status. Refresh source control and try again.`
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
  // Why: the base is only a candidate; fall back to repo default so a local-only parent targets a remote-resolvable ref.
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
  // Why: track lookup failure so a swallowed error isn't mistaken for authoritative no-review evidence.
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
      // Why: eligibility is only ever asked for the worktree the user is acting
      // on, so it earns the fast tier. Without it a review opened outside Orca
      // in the last no-review interval would leave Create enabled (#11532).
      active: true,
      ...hostedReviewExecutionContext(args)
    })
  } catch (error) {
    // Why: a failed lookup might hide a real PR, so record unavailable and fall through rather than rethrow.
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
  // Why: providers target the submitted base verbatim; block a local-only base here with actionable copy.
  if (args.enforceBaseOnRemote && candidateBase && !candidateBaseOnRemote) {
    return {
      ...baseResult,
      canCreate: false,
      blockedReason: 'base_not_on_remote',
      nextAction: null
    }
  }
  // Why: a failed lookup leaves review existence unproven, so the happy path must not claim canCreate.
  return {
    ...baseResult,
    canCreate: lookupFailed ? false : Boolean(baseBranch),
    blockedReason: null,
    nextAction: null
  }
}

export async function createHostedReview(
  repoPath: string,
  input: CreateHostedReviewInput,
  executionHostId: ExecutionHostId,
  options: HostedReviewExecutionOptions = {}
): Promise<CreateHostedReviewResult> {
  if (!supportsHostedReviewCreation(input.provider)) {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating reviews for this provider is not supported yet.'
    }
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
      error: `Creating ${copy.reviewLabel}s requires a ${copy.providerName} remote.`
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
    // Why (#11532): the branch cache holds a "no review" answer for far longer
    // than a poll interval, so Orca's own creation must retire it at once.
    invalidateHostedReviewBranchCache(repoPath, executionHostId)
  }
  return result
}
