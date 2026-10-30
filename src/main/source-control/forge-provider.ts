import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  CreateHostedReviewInput,
  CreateHostedReviewResult,
  HostedReviewInfo,
  HostedReviewProvider
} from '../../shared/hosted-review'
import {
  getAzureDevOpsPullRequest,
  getAzureDevOpsPullRequestForBranchOrThrow,
  getAzureDevOpsRepoSlug
} from '../azure-devops/client'
import { createAzureDevOpsPullRequest } from '../azure-devops/pull-request-creation'
import {
  getBitbucketPullRequest,
  getBitbucketPullRequestForBranchOrThrow,
  getBitbucketRepoSlug
} from '../bitbucket/client'
import { createBitbucketPullRequest } from '../bitbucket/pull-request-creation'
import {
  getGiteaPullRequest,
  getGiteaPullRequestForBranchOrThrow,
  getGiteaRepoSlug
} from '../gitea/client'
import { createGiteaPullRequest } from '../gitea/pull-request-creation'
import {
  createGitHubPullRequest,
  getGitHubPRLookupRateLimitBlock,
  getPRForBranchOutcome,
  getRepoSlug
} from '../github/client'
import { getMergeRequest, getMergeRequestForBranchOrThrow, getProjectSlug } from '../gitlab/client'
import { createGitLabMergeRequest } from '../gitlab/merge-request-creation'
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
  // GitHub-only merged-at-head visibility; other providers ignore this inspected HEAD.
  githubCurrentHeadOid?: string | null
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
  resolveRepository: (context) =>
    getProjectSlug(
      context.repoPath,
      forgeConnectionId(context),
      ...hostedReviewExecutionArgs(context)
    ),
  async getReviewForBranch(input) {
    // Preserve lookup failure as unavailable so callers retain last-known review state.
    const mr = await getMergeRequestForBranchOrThrow(
      input.repoPath,
      input.branch,
      input.linkedReviewNumber ?? null,
      forgeConnectionId(input),
      ...hostedReviewExecutionArgs(input)
    )
    return mr ? mapGitLabReview(mr) : null
  },
  async getReviewByNumber(input) {
    const mr = await getMergeRequest(
      input.repoPath,
      input.number,
      forgeConnectionId(input),
      ...hostedReviewExecutionArgs(input)
    )
    return mr ? mapGitLabReview(mr) : null
  },
  createReview: createGitLabMergeRequest
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
        ...(fallbackReviewNumber !== null ? { acceptMergedFallbackPR: true } : {}),
        currentHeadOid: input.githubCurrentHeadOid ?? null
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
  resolveRepository: (context) =>
    getBitbucketRepoSlug(
      context.repoPath,
      forgeConnectionId(context),
      ...hostedReviewExecutionArgs(context)
    ),
  async getReviewForBranch(input) {
    // Lookup failure is unavailable, never proof no review exists.
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
    const pr = await getBitbucketPullRequest(
      input.repoPath,
      input.number,
      forgeConnectionId(input),
      ...hostedReviewExecutionArgs(input)
    )
    return pr ? mapBitbucketReview(pr) : null
  },
  createReview: createBitbucketPullRequest
} satisfies ForgeProvider

const azureDevOpsForgeProvider = {
  id: 'azure-devops',
  supportsReviewCreation: true,
  resolveRepository: (context) =>
    getAzureDevOpsRepoSlug(
      context.repoPath,
      forgeConnectionId(context),
      ...hostedReviewExecutionArgs(context)
    ),
  async getReviewForBranch(input) {
    // Lookup failure is unavailable, never proof no review exists.
    const pr = await getAzureDevOpsPullRequestForBranchOrThrow(
      input.repoPath,
      input.branch,
      input.linkedReviewNumber ?? null,
      forgeConnectionId(input),
      ...hostedReviewExecutionArgs(input)
    )
    return pr ? mapAzureDevOpsReview(pr) : null
  },
  async getReviewByNumber(input) {
    const pr = await getAzureDevOpsPullRequest(
      input.repoPath,
      input.number,
      forgeConnectionId(input),
      ...hostedReviewExecutionArgs(input)
    )
    return pr ? mapAzureDevOpsReview(pr) : null
  },
  createReview: createAzureDevOpsPullRequest
} satisfies ForgeProvider

const giteaForgeProvider = {
  id: 'gitea',
  supportsReviewCreation: true,
  resolveRepository: (context) =>
    getGiteaRepoSlug(
      context.repoPath,
      forgeConnectionId(context),
      ...hostedReviewExecutionArgs(context)
    ),
  async getReviewForBranch(input) {
    // Lookup failure is unavailable, never proof no review exists.
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
    const pr = await getGiteaPullRequest(
      input.repoPath,
      input.number,
      forgeConnectionId(input),
      ...hostedReviewExecutionArgs(input)
    )
    return pr ? mapGiteaReview(pr) : null
  },
  createReview: createGiteaPullRequest
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

export async function getForgeProviderForRepository(
  context: ForgeProviderRepositoryContext
): Promise<ForgeProvider | null> {
  for (const provider of FORGE_PROVIDERS) {
    if (await provider.resolveRepository(context)) {
      return provider
    }
  }
  return null
}

export async function detectHostedReviewProvider(
  context: ForgeProviderRepositoryContext
): Promise<HostedReviewProvider> {
  return (await getForgeProviderForRepository(context))?.id ?? 'unsupported'
}
