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
    lower.includes('connection reset')
  ) {
    return 'network'
  }
  if (lower.includes('http 403') || lower.includes('forbidden')) {
    return 'permission'
  }
  if (lower.includes('http 404') || lower.includes('could not resolve to a repository')) {
    return 'repo_unavailable'
  }
  if (/auth|login|credential/i.test(message)) {
    return 'auth'
  }
  if (/command not found|enoent|not installed/i.test(message)) {
    return 'cli_unavailable'
  }
  return null
}

function reviewLinkForProvider(
  input: Parameters<typeof getHostedReviewForBranch>[0],
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

export async function getHostedReviewForBranch(
  input: {
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
): Promise<HostedReviewInfo | null> {
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
    return null
  }

  const provider = await getForgeProviderForRepository({
    repoPath: input.repoPath,
    connectionId: input.connectionId,
    ...(input.localGitExecOptions ? { localGitExecOptions: input.localGitExecOptions } : {})
  })
  if (!provider) {
    return null
  }
  try {
    return await provider.getReviewForBranch({
      repoPath: input.repoPath,
      connectionId: input.connectionId,
      branch: branchName,
      ...(input.localGitExecOptions ? { localGitExecOptions: input.localGitExecOptions } : {}),
      githubCurrentHeadOid: input.currentHeadOid ?? null,
      ...reviewLinkForProvider(input, provider.id)
    })
  } catch (error) {
    if (error instanceof HostedReviewLookupError) {
      throw error
    }
    const errorType = classifyHostedReviewProviderError(error)
    if (!errorType) {
      throw error
    }
    // Why: provider clients may throw secrets or command text; retain the cause
    // in-process while exposing only a stable, safe classification to IPC/RPC.
    throw new HostedReviewLookupError(provider.id, errorType, 'Hosted review lookup failed.', {
      cause: error
    })
  }
}

/** Projects an expected lookup failure into a redaction-safe transport result.
 * @throws The original value when it is not a classified provider failure. */
export function hostedReviewLookupFailure(error: unknown): HostedReviewLookupResult {
  if (error instanceof HostedReviewLookupError) {
    return {
      kind: 'upstream-error',
      provider: error.provider,
      errorType: error.errorType
    }
  }
  throw error
}

/** Looks up a branch review without throwing expected provider failures across IPC. */
export async function getHostedReviewForBranchResult(
  input: Parameters<typeof getHostedReviewForBranch>[0]
): Promise<HostedReviewLookupResult> {
  try {
    const review = await getHostedReviewForBranch(input)
    return review ? { kind: 'found', review } : { kind: 'not-found' }
  } catch (error) {
    return hostedReviewLookupFailure(error)
  }
}
