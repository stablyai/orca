import type { ExecutionHostId } from '../../shared/execution-host/execution-host'
import type {
  CreateHostedReviewInput,
  CreateHostedReviewResult,
  HostedReviewInfo,
  HostedReviewProvider
} from '../../shared/source-control/hosted-review/hosted-review-contracts'
import { createGitHubPullRequest } from '../github/client/create/create-github-pull-request'
import { getGitHubPRLookupRateLimitBlock } from '../github/client/lookup/pr-lookup-rate-limit'
import { getPRForBranchOutcome } from '../github/client/lookup/pr-for-branch-outcome'
import { getRepoSlug } from '../github/client/fetch/repo-slug-upstream'
import {
  mapAzureDevOpsReview,
  mapBitbucketReview,
  mapGiteaReview,
  mapGitHubReview,
  mapGitLabReview
} from './forge-review-mappers'
import { hostedReviewSshConnectionId } from './hosted-review-execution-host'
import {
  hasHostedReviewLocalGitOptions,
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from './hosted-review-git-options'

export type ForgeProviderId = Exclude<HostedReviewProvider, 'unsupported'>

export type ForgeProviderRepositoryContext = HostedReviewExecutionOptions & {
  repoPath: string
  /** Resolved, never null: `local` and "unresolved" are no longer the same value. */
  executionHostId: ExecutionHostId
}

export type ForgeReviewForBranchInput = ForgeProviderRepositoryContext & {
  branch: string
  linkedReviewNumber?: number | null
  fallbackReviewNumber?: number | null
  // The inspected checkout HEAD scopes implicit merged-review visibility.
  currentHeadOid?: string | null
  userRefresh?: boolean
}

export type ForgeReviewByNumberInput = ForgeProviderRepositoryContext & {
  number: number
}

export type ForgeProvider = {
  id: ForgeProviderId
  supportsReviewCreation: boolean
  resolveRepository(context: ForgeProviderRepositoryContext): Promise<unknown>
  getReviewForBranch(input: ForgeReviewForBranchInput): Promise<HostedReviewInfo | null>
  getReviewByNumber(input: ForgeReviewByNumberInput): Promise<HostedReviewInfo | null>
  createReview?(
    repoPath: string,
    input: CreateHostedReviewInput,
    executionHostId: ExecutionHostId,
    options?: HostedReviewExecutionOptions
  ): Promise<CreateHostedReviewResult>
}

/** Forge CLIs/API clients run here; only their Git reads route to SSH. */
function forgeConnectionId(context: ForgeProviderRepositoryContext): string | null {
  return hostedReviewSshConnectionId(context.executionHostId)
}

function hostedReviewExecutionArgs(
  options: HostedReviewExecutionOptions
): [] | [HostedReviewExecutionOptions] {
  return hasHostedReviewLocalGitOptions(options)
    ? [{ localGitExecOptions: getHostedReviewLocalGitOptions(options) }]
    : []
}

const gitLabForgeProvider = {
  id: 'gitlab',
  supportsReviewCreation: true,
  resolveRepository: async (context) => {
    const { getProjectSlug } = await import('../gitlab/merge-requests/merge-request-lookup')
    return getProjectSlug(
      context.repoPath,
      forgeConnectionId(context),
      ...hostedReviewExecutionArgs(context)
    )
  },
  async getReviewForBranch(input) {
    // Preserve lookup failure as unavailable so callers retain last-known review state.
    const { getMergeRequestForBranchOrThrow } =
      await import('../gitlab/merge-requests/merge-request-lookup')
    const mr = await getMergeRequestForBranchOrThrow(
      input.repoPath,
      input.branch,
      input.linkedReviewNumber ?? null,
      forgeConnectionId(input),
      { ...input, currentHeadOid: input.currentHeadOid }
    )
    return mr ? mapGitLabReview(mr) : null
  },
  async getReviewByNumber(input) {
    const { getMergeRequest } = await import('../gitlab/merge-requests/merge-request-lookup')
    const mr = await getMergeRequest(
      input.repoPath,
      input.number,
      forgeConnectionId(input),
      ...hostedReviewExecutionArgs(input)
    )
    return mr ? mapGitLabReview(mr) : null
  },
  createReview: async (...args) =>
    (await import('../gitlab/merge-requests/merge-request-creation')).createGitLabMergeRequest(
      ...args
    )
} satisfies ForgeProvider

// Upstream errors must not poison caches with authoritative no-review answers.
function unwrapGitHubPRForBranchOutcome(
  outcome: Awaited<ReturnType<typeof getPRForBranchOutcome>>
): HostedReviewInfo | null {
  if (outcome.kind === 'upstream-error') {
    throw new Error(`GitHub PR lookup failed (${outcome.errorType}): ${outcome.message}`)
  }
  return outcome.kind === 'found' ? mapGitHubReview(outcome.pr) : null
}

/** Hosted lookups bypass the paced PR queue but share its rate-limit floor; throw on low budget to preserve cached answers (#11532). */
async function assertGitHubReviewRateLimitBudget(
  input: ForgeProviderRepositoryContext
): Promise<void> {
  const block = await getGitHubPRLookupRateLimitBlock(
    input.repoPath,
    forgeConnectionId(input),
    getHostedReviewLocalGitOptions(input)
  )
  if (block) {
    throw new Error(
      `GitHub PR lookup failed (rate_limited): GitHub rate limit is low. Try again after ${new Date(
        block.resetAt * 1000
      ).toLocaleTimeString()}.`
    )
  }
}

const gitHubForgeProvider = {
  id: 'github',
  supportsReviewCreation: true,
  // Authenticated GHES resolves as GitHub, preventing Gitea fallback (#8312).
  resolveRepository: async (context) =>
    getRepoSlug(
      context.repoPath,
      forgeConnectionId(context),
      ...hostedReviewExecutionArgs(context)
    ),
  async getReviewForBranch(input) {
    await assertGitHubReviewRateLimitBudget(input)
    const fallbackReviewNumber =
      input.linkedReviewNumber == null ? (input.fallbackReviewNumber ?? null) : null
    const executionArgs = hostedReviewExecutionArgs(input)
    const outcome = await getPRForBranchOutcome(
      input.repoPath,
      input.branch,
      input.linkedReviewNumber ?? null,
      forgeConnectionId(input),
      fallbackReviewNumber,
      {
        ...executionArgs[0],
        ...(input.userRefresh === true ? { userRefresh: true } : {}),
        ...(fallbackReviewNumber !== null ? { acceptMergedFallbackPR: true } : {}),
        currentHeadOid: input.currentHeadOid ?? null
      }
    )
    return unwrapGitHubPRForBranchOutcome(outcome)
  },
  async getReviewByNumber(input) {
    await assertGitHubReviewRateLimitBudget(input)
    const executionArgs = hostedReviewExecutionArgs(input)
    const outcome =
      executionArgs.length > 0
        ? await getPRForBranchOutcome(
            input.repoPath,
            '',
            input.number,
            forgeConnectionId(input),
            null,
            ...executionArgs
          )
        : await getPRForBranchOutcome(input.repoPath, '', input.number, forgeConnectionId(input))
    return unwrapGitHubPRForBranchOutcome(outcome)
  },
  createReview: createGitHubPullRequest
} satisfies ForgeProvider

const bitbucketForgeProvider = {
  id: 'bitbucket',
  supportsReviewCreation: true,
  resolveRepository: async (context) =>
    (await import('../bitbucket/client')).getBitbucketRepoSlug(
      context.repoPath,
      forgeConnectionId(context),
      ...hostedReviewExecutionArgs(context)
    ),
  async getReviewForBranch(input) {
    // Lookup failure is unavailable, never proof no review exists.
    const { getBitbucketPullRequestForBranchOrThrow } = await import('../bitbucket/client')
    const pr = await getBitbucketPullRequestForBranchOrThrow(
      input.repoPath,
      input.branch,
      input.linkedReviewNumber ?? null,
      forgeConnectionId(input),
      ...hostedReviewExecutionArgs(input)
    )
    return pr ? mapBitbucketReview(pr) : null
  },
  async getReviewByNumber(input) {
    const { getBitbucketPullRequest } = await import('../bitbucket/client')
    const pr = await getBitbucketPullRequest(
      input.repoPath,
      input.number,
      forgeConnectionId(input),
      ...hostedReviewExecutionArgs(input)
    )
    return pr ? mapBitbucketReview(pr) : null
  },
  createReview: async (...args) =>
    (await import('../bitbucket/pull-request-creation')).createBitbucketPullRequest(...args)
} satisfies ForgeProvider

const azureDevOpsForgeProvider = {
  id: 'azure-devops',
  supportsReviewCreation: true,
  resolveRepository: async (context) =>
    (await import('../azure-devops/client')).getAzureDevOpsRepoSlug(
      context.repoPath,
      forgeConnectionId(context),
      ...hostedReviewExecutionArgs(context)
    ),
  async getReviewForBranch(input) {
    // Lookup failure is unavailable, never proof no review exists.
    const { getAzureDevOpsPullRequestForBranchOrThrow } = await import('../azure-devops/client')
    const pr = await getAzureDevOpsPullRequestForBranchOrThrow(
      input.repoPath,
      input.branch,
      input.linkedReviewNumber ?? null,
      forgeConnectionId(input),
      input
    )
    return pr ? mapAzureDevOpsReview(pr) : null
  },
  async getReviewByNumber(input) {
    const { getAzureDevOpsPullRequest } = await import('../azure-devops/client')
    const pr = await getAzureDevOpsPullRequest(
      input.repoPath,
      input.number,
      forgeConnectionId(input),
      ...hostedReviewExecutionArgs(input)
    )
    return pr ? mapAzureDevOpsReview(pr) : null
  },
  createReview: async (repoPath, input, executionHostId) =>
    (await import('../azure-devops/pull-request-creation')).createAzureDevOpsPullRequest(
      repoPath,
      input,
      executionHostId
    )
} satisfies ForgeProvider

const giteaForgeProvider = {
  id: 'gitea',
  supportsReviewCreation: true,
  resolveRepository: async (context) =>
    (await import('../gitea/client')).getGiteaRepoSlug(
      context.repoPath,
      forgeConnectionId(context),
      ...hostedReviewExecutionArgs(context)
    ),
  async getReviewForBranch(input) {
    // Lookup failure is unavailable, never proof no review exists.
    const { getGiteaPullRequestForBranchOrThrow } = await import('../gitea/client')
    const pr = await getGiteaPullRequestForBranchOrThrow(
      input.repoPath,
      input.branch,
      input.linkedReviewNumber ?? null,
      forgeConnectionId(input),
      ...hostedReviewExecutionArgs(input)
    )
    return pr ? mapGiteaReview(pr) : null
  },
  async getReviewByNumber(input) {
    const { getGiteaPullRequest } = await import('../gitea/client')
    const pr = await getGiteaPullRequest(
      input.repoPath,
      input.number,
      forgeConnectionId(input),
      ...hostedReviewExecutionArgs(input)
    )
    return pr ? mapGiteaReview(pr) : null
  },
  createReview: async (repoPath, input, executionHostId) =>
    (await import('../gitea/pull-request-creation')).createGiteaPullRequest(
      repoPath,
      input,
      executionHostId
    )
} satisfies ForgeProvider

// Preserve precedence when multiple providers can interpret a remote.
export const FORGE_PROVIDERS = [
  gitLabForgeProvider,
  gitHubForgeProvider,
  bitbucketForgeProvider,
  azureDevOpsForgeProvider,
  giteaForgeProvider
] as const satisfies readonly ForgeProvider[]

export function getForgeProviderById(id: ForgeProviderId): ForgeProvider {
  return FORGE_PROVIDERS.find((provider) => provider.id === id) ?? gitHubForgeProvider
}
