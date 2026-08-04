// The forge adapter (Phase 9 P4): a narrow boundary around the existing
// provider-neutral ForgeProvider layer.
//
// TWO RULES GOVERN THIS FILE.
//
// 1. NOTHING here can fail a publish. By the time it runs, the remote provably
//    carries the audited sha. Every outcome — including auth failures and
//    provider rejections — is returned as a PublishAdvisoryCode. The return type
//    makes reporting a failure structurally impossible.
//
// 2. NO provider text crosses. CreateHostedReviewResult carries a free-text
//    `error` produced by gh/glab; it is read for classification and DROPPED here.
//    Neither it, nor a URL, nor a payload reaches a projection or a log.
//
// The ForgeProvider layer is reused rather than reimplemented, but
// createHostedReview() is deliberately NOT called: its preflight validates the
// CURRENT BRANCH, and the audited lane pushes an exact sha whose worktree may
// have moved on. We resolve the provider and call createReview directly, keeping
// the duplicate-safety invariant explicitly (below).
import type {
  CreateHostedReviewErrorCode,
  CreateHostedReviewInput,
  HostedReviewProvider
} from '../../shared/hosted-review'
import { supportsHostedReviewCreation } from '../../shared/hosted-review-creation-providers'
import type { PublishAdvisoryCode } from '../../shared/audited-publish-types'
import { getForgeProviderForRepository, type ForgeProvider } from '../source-control/forge-provider'

export type ReviewRequestOutcome = {
  advisory: PublishAdvisoryCode
  provider: HostedReviewProvider | null
  number: number | null
  url: string | null
  created: boolean
}

/**
 * Maps a provider error code to an advisory.
 *
 * Exhaustive with NO default, so a new CreateHostedReviewErrorCode member fails
 * the build rather than silently degrading to `deferred`. The distinctions are
 * load-bearing:
 *   - auth_required is NOT deferred: it fails identically until the human runs
 *     gh/glab auth login, so a bare Retry would loop.
 *   - validation is NOT deferred: retrying the identical request reproduces it.
 *   - unknown_completion is NEVER guessed either way.
 */
function advisoryForErrorCode(code: CreateHostedReviewErrorCode): PublishAdvisoryCode {
  switch (code) {
    case 'auth_required':
      return 'review_request_auth_required'
    case 'unsupported_provider':
      return 'review_request_unsupported_provider'
    case 'already_exists':
      return 'review_request_already_exists'
    case 'validation':
      return 'review_request_validation_failed'
    case 'timeout':
    case 'unknown_completion':
      return 'review_request_ambiguous'
    // push_failed can never be the truthful answer here: the push is already
    // confirmed durable before this adapter runs.
    case 'push_failed':
    case 'unknown':
      return 'review_request_deferred'
  }
}

/**
 * Whether a provider can create reviews at all.
 *
 * Handles all six HostedReviewProvider members exhaustively — bitbucket and
 * `unsupported` are the truthful no-creation paths.
 */
function providerSupportsCreation(provider: HostedReviewProvider): boolean {
  switch (provider) {
    case 'github':
    case 'gitlab':
    case 'azure-devops':
    case 'gitea':
      return true
    case 'bitbucket':
    case 'unsupported':
      return false
  }
}

async function resolveProvider(repoPath: string): Promise<ForgeProvider | null> {
  try {
    return await getForgeProviderForRepository({ repoPath })
  } catch {
    // A detection failure is a transient condition, not a definitive "no
    // provider" — the caller maps a null to `deferred`, never to unsupported.
    return null
  }
}

/**
 * Looks for an already-open review on the branch.
 *
 * Returns `undefined` when the lookup itself FAILED — which is not the same as
 * "there is none". The caller must refuse to create in that case rather than
 * risk a duplicate (the invariant hosted-review-creation.ts states as design
 * invariant 8).
 */
async function findExistingReview(
  provider: ForgeProvider,
  repoPath: string,
  branch: string
): Promise<{ number: number; url: string } | null | undefined> {
  try {
    const existing = await provider.getReviewForBranch({ repoPath, branch })
    return existing ? { number: existing.number, url: existing.url } : null
  } catch {
    return undefined
  }
}

/**
 * Creates or adopts a review request for a branch already present on the remote.
 *
 * NEVER pushes and never touches Git: the branch is on the remote before this
 * runs. Returns an advisory in every case, including success.
 */
export async function requestReview(args: {
  repoPath: string
  branch: string
  baseBranch: string
  title: string
  body: string
  draft: boolean
}): Promise<ReviewRequestOutcome> {
  const provider = await resolveProvider(args.repoPath)
  if (!provider) {
    return {
      advisory: 'review_request_deferred',
      provider: null,
      number: null,
      url: null,
      created: false
    }
  }

  const providerId: HostedReviewProvider = provider.id
  if (!providerSupportsCreation(providerId) || !supportsHostedReviewCreation(providerId)) {
    return {
      advisory: 'review_request_unsupported_provider',
      provider: providerId,
      number: null,
      url: null,
      created: false
    }
  }

  // DUPLICATE SAFETY, checked before every creation — including a retry after an
  // ambiguous outcome, which is precisely what makes that retry safe.
  const existing = await findExistingReview(provider, args.repoPath, args.branch)
  if (existing === undefined) {
    // The lookup failed, so we cannot know whether one exists. Refuse to create.
    return {
      advisory: 'review_request_deferred',
      provider: providerId,
      number: null,
      url: null,
      created: false
    }
  }
  if (existing) {
    return {
      advisory: 'review_request_already_exists',
      provider: providerId,
      number: existing.number,
      url: existing.url,
      created: false
    }
  }

  if (!provider.createReview) {
    return {
      advisory: 'review_request_unsupported_provider',
      provider: providerId,
      number: null,
      url: null,
      created: false
    }
  }

  const input: CreateHostedReviewInput = {
    provider: providerId,
    base: args.baseBranch,
    head: args.branch,
    title: args.title,
    body: args.body,
    draft: args.draft
  }

  try {
    const result = await provider.createReview(args.repoPath, input)
    if (result.ok) {
      return {
        advisory: 'review_request_created',
        provider: providerId,
        number: result.number,
        url: result.url,
        created: true
      }
    }
    // `result.error` is free provider text and is deliberately NOT read here.
    const advisory = advisoryForErrorCode(result.code)
    const adopted = result.existingReview
    if (advisory === 'review_request_already_exists' && adopted?.number !== undefined) {
      return {
        advisory,
        provider: providerId,
        number: adopted.number,
        url: adopted.url,
        created: false
      }
    }
    return { advisory, provider: providerId, number: null, url: null, created: false }
  } catch {
    // A thrown provider error is indistinguishable from a transport fault, so it
    // is deferred — never reported as a publish failure.
    return {
      advisory: 'review_request_deferred',
      provider: providerId,
      number: null,
      url: null,
      created: false
    }
  }
}
