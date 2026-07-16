import type { HostedReviewInfo, HostedReviewLookupResult } from '../../shared/hosted-review'
import {
  getForgeProviderForRepository,
  HostedReviewLookupError,
  type ForgeProviderId
} from './forge-provider'
import type { HostedReviewExecutionOptions } from './hosted-review-git-options'

function classifyHostedReviewProviderError(
  error: unknown
): HostedReviewLookupError['errorType'] | null {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  if (lower.includes('rate limit') || lower.includes('http 429')) {
    return 'rate_limited'
  }
  if (
    lower.includes('timeout') ||
    lower.includes('network') ||
    lower.includes('no such host') ||
    lower.includes('could not resolve host') ||
    lower.includes('connection reset') ||
    /http 5\d\d/.test(lower)
  ) {
    return 'network'
  }
  if (lower.includes('http 403') || lower.includes('forbidden')) {
    return 'permission'
  }
  if (lower.includes('http 404') || lower.includes('could not resolve to a repository')) {
    return 'repo_unavailable'
  }
  if (lower.includes('http 401') || /auth|login|credential/i.test(message)) {
    return 'auth'
  }
  if (/command not found|enoent|not installed/i.test(message)) {
    return 'cli_unavailable'
  }
  return null
}

function reviewLinkForProvider(
  input: HostedReviewLookupInput,
  provider: ForgeProviderId
): { linkedReviewNumber?: number | null; fallbackReviewNumber?: number | null } {
  switch (provider) {
    case 'github':
      return {
        linkedReviewNumber: input.linkedGitHubPR ?? null,
        fallbackReviewNumber: input.linkedGitHubPR == null ? (input.fallbackGitHubPR ?? null) : null
      }
    case 'gitlab':
      return { linkedReviewNumber: input.linkedGitLabMR ?? null }
    case 'bitbucket':
      return { linkedReviewNumber: input.linkedBitbucketPR ?? null }
    case 'azure-devops':
      return { linkedReviewNumber: input.linkedAzureDevOpsPR ?? null }
    case 'gitea':
      return { linkedReviewNumber: input.linkedGiteaPR ?? null }
  }
}

type HostedReviewLookupInput = {
  repoPath: string
  connectionId?: string | null
  branch: string
  linkedGitHubPR?: number | null
  fallbackGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
  currentHeadOid?: string | null
} & HostedReviewExecutionOptions

/** Resolves a branch review, throwing classified provider failures to legacy callers. */
export async function getHostedReviewForBranch(
  input: HostedReviewLookupInput
): Promise<HostedReviewInfo | null> {
  const result = await lookupHostedReviewForBranch(input)
  switch (result.kind) {
    case 'found':
      return result.review
    case 'not-found':
      return null
    case 'upstream-error':
      throw new HostedReviewLookupError(
        result.provider,
        result.errorType,
        'Hosted review lookup failed.'
      )
  }
}

/** Resolves a branch review with expected discovery and provider failures as values. */
export async function lookupHostedReviewForBranch(
  input: HostedReviewLookupInput
): Promise<HostedReviewLookupResult> {
  const branchName = input.branch.replace(/^refs\/heads\//, '')
  // Why: detached HEAD cannot use branch lookup, but provider-specific exact
  // ids can still resolve the review without probing an empty branch name.
  if (
    !branchName &&
    input.linkedGitHubPR == null &&
    input.fallbackGitHubPR == null &&
    input.linkedGitLabMR == null &&
    input.linkedBitbucketPR == null &&
    input.linkedAzureDevOpsPR == null &&
    input.linkedGiteaPR == null
  ) {
    return { kind: 'not-found' }
  }

  let provider
  try {
    provider = await getForgeProviderForRepository({
      repoPath: input.repoPath,
      connectionId: input.connectionId,
      ...(input.localGitExecOptions ? { localGitExecOptions: input.localGitExecOptions } : {})
    })
  } catch (error) {
    return hostedReviewLookupFailure(error, 'unknown')
  }
  if (!provider) {
    return { kind: 'not-found' }
  }
  try {
    const review = await provider.getReviewForBranch({
      repoPath: input.repoPath,
      connectionId: input.connectionId,
      branch: branchName,
      ...(input.localGitExecOptions ? { localGitExecOptions: input.localGitExecOptions } : {}),
      githubCurrentHeadOid: input.currentHeadOid ?? null,
      ...reviewLinkForProvider(input, provider.id)
    })
    return review ? { kind: 'found', review } : { kind: 'not-found' }
  } catch (error) {
    return hostedReviewLookupFailure(error, provider.id)
  }
}

/** Projects an expected lookup failure into a redaction-safe transport result.
 * @throws The original value when it is not a classified provider failure. */
export function hostedReviewLookupFailure(
  error: unknown,
  provider: ForgeProviderId | 'unknown' = 'unknown'
): HostedReviewLookupResult {
  if (error instanceof HostedReviewLookupError) {
    return {
      kind: 'upstream-error',
      provider: error.provider,
      errorType: error.errorType
    }
  }
  const errorType = classifyHostedReviewProviderError(error)
  if (!errorType) {
    throw error
  }
  // Why: provider clients may throw secrets or command text; serialize only a
  // stable classification while the original failure remains local.
  return { kind: 'upstream-error', provider, errorType }
}
