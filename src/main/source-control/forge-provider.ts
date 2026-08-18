import type {
  CreateHostedReviewInput,
  CreateHostedReviewResult,
  HostedReviewInfo,
  HostedReviewProvider
} from '../../shared/hosted-review'
import type {
  ApproveHostedReviewInput,
  ApproveHostedReviewResult,
  CommentHostedReviewInput,
  CommentHostedReviewResult,
  ListHostedReviewCommentsInput,
  ListHostedReviewCommentsResult,
  ListHostedReviewIssuesInput,
  ListHostedReviewIssuesResult,
  MergeHostedReviewInput,
  MergeHostedReviewResult
} from '../../shared/hosted-review-actions'
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
  getGiteaAuthStatus,
  getGiteaPullRequest,
  getGiteaPullRequestForBranchOrThrow,
  getGiteaRepoSlug,
  isGiteaTokenVerifiedAtBase
} from '../gitea/client'
import {
  createGiteaPullRequest,
  isGiteaReviewCreationAuthenticated
} from '../gitea/pull-request-creation'
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
import {
  hasHostedReviewLocalGitOptions,
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from './hosted-review-git-options'
import { resolvePluginForgeProvider } from './plugin-forge-provider-bridge'

export type ForgeProviderId = Exclude<HostedReviewProvider, 'unsupported'>

export type ForgeProviderRepositoryContext = HostedReviewExecutionOptions & {
  repoPath: string
  connectionId?: string | null
}

export type ForgeReviewForBranchInput = ForgeProviderRepositoryContext & {
  branch: string
  linkedReviewNumber?: number | null
  fallbackReviewNumber?: number | null
  // GitHub-only: lets the GitHub provider keep merged-at-head PRs visible using
  // the inspected worktree HEAD. Ignored by other providers.
  githubCurrentHeadOid?: string | null
}

export type ForgeReviewByNumberInput = ForgeProviderRepositoryContext & {
  number: number
}

export type ForgeProviderCopy = {
  shortLabel: string
  reviewLabel: string
  titleLabel: string
  providerName: string
  authInstruction: string
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
    connectionId?: string | null,
    options?: HostedReviewExecutionOptions
  ): Promise<CreateHostedReviewResult>
  copy?: ForgeProviderCopy
  isAuthenticated?(context: ForgeProviderRepositoryContext): Promise<boolean>
  mergeReview?(input: MergeHostedReviewInput): Promise<MergeHostedReviewResult>
  commentReview?(input: CommentHostedReviewInput): Promise<CommentHostedReviewResult>
  approveReview?(input: ApproveHostedReviewInput): Promise<ApproveHostedReviewResult>
  listReviewComments?(input: ListHostedReviewCommentsInput): Promise<ListHostedReviewCommentsResult>
  listIssues?(input: ListHostedReviewIssuesInput): Promise<ListHostedReviewIssuesResult>
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
    getProjectSlug(context.repoPath, context.connectionId, ...hostedReviewExecutionArgs(context)),
  async getReviewForBranch(input) {
    // Why: throw (not null) on a real lookup failure so eligibility records
    // `unavailable`, never a false "No merge request found" — same contract the
    // GitHub adapter uses so hosted-review callers preserve last-known state.
    const mr = await getMergeRequestForBranchOrThrow(
      input.repoPath,
      input.branch,
      input.linkedReviewNumber ?? null,
      input.connectionId,
      ...hostedReviewExecutionArgs(input)
    )
    return mr ? mapGitLabReview(mr) : null
  },
  async getReviewByNumber(input) {
    const mr = await getMergeRequest(
      input.repoPath,
      input.number,
      input.connectionId,
      ...hostedReviewExecutionArgs(input)
    )
    return mr ? mapGitLabReview(mr) : null
  },
  createReview: createGitLabMergeRequest
} satisfies ForgeProvider

// Why: collapsing an upstream error into a null "no review" lets a transient
// gh/git failure poison the sidebar's hosted-review cache with a definitive
// miss. Surface the error so callers can preserve the last known review state,
// mirroring how the PR refresh coordinator keeps cache on upstream-error.
function unwrapGitHubPRForBranchOutcome(
  outcome: Awaited<ReturnType<typeof getPRForBranchOutcome>>
): HostedReviewInfo | null {
  if (outcome.kind === 'upstream-error') {
    throw new Error(`GitHub PR lookup failed (${outcome.errorType}): ${outcome.message}`)
  }
  return outcome.kind === 'found' ? mapGitHubReview(outcome.pr) : null
}

/**
 * Why (#11532): hosted-review lookups reach GitHub outside the PR refresh
 * coordinator's paced queue, so they need the same rate-limit floor. Throwing
 * (rather than returning null) keeps a low budget from reading as "no pull
 * request" — callers preserve the last known review and back off.
 */
async function assertGitHubReviewRateLimitBudget(
  input: ForgeProviderRepositoryContext
): Promise<void> {
  const block = await getGitHubPRLookupRateLimitBlock(
    input.repoPath,
    input.connectionId,
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
  // Why: getRepoSlug resolves hosted identities — GHES remotes are claimed when
  // gh is authenticated to their host (the same signal GitLab uses for
  // self-hosted instances), so detection never falls through to Gitea (#8312).
  resolveRepository: async (context) =>
    getRepoSlug(context.repoPath, context.connectionId, ...hostedReviewExecutionArgs(context)),
  async getReviewForBranch(input) {
    await assertGitHubReviewRateLimitBudget(input)
    const fallbackReviewNumber =
      input.linkedReviewNumber == null ? (input.fallbackReviewNumber ?? null) : null
    const executionArgs = hostedReviewExecutionArgs(input)
    const outcome = await getPRForBranchOutcome(
      input.repoPath,
      input.branch,
      input.linkedReviewNumber ?? null,
      input.connectionId,
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
            input.connectionId,
            null,
            ...executionArgs
          )
        : await getPRForBranchOutcome(input.repoPath, '', input.number, input.connectionId)
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
      context.connectionId,
      ...hostedReviewExecutionArgs(context)
    ),
  async getReviewForBranch(input) {
    const pr = await getBitbucketPullRequestForBranchOrThrow(
      input.repoPath,
      input.branch,
      input.linkedReviewNumber ?? null,
      input.connectionId,
      ...hostedReviewExecutionArgs(input)
    )
    return pr ? mapBitbucketReview(pr) : null
  },
  async getReviewByNumber(input) {
    const pr = await getBitbucketPullRequest(
      input.repoPath,
      input.number,
      input.connectionId,
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
      context.connectionId,
      ...hostedReviewExecutionArgs(context)
    ),
  async getReviewForBranch(input) {
    const pr = await getAzureDevOpsPullRequestForBranchOrThrow(
      input.repoPath,
      input.branch,
      input.linkedReviewNumber ?? null,
      input.connectionId,
      ...hostedReviewExecutionArgs(input)
    )
    return pr ? mapAzureDevOpsReview(pr) : null
  },
  async getReviewByNumber(input) {
    const pr = await getAzureDevOpsPullRequest(
      input.repoPath,
      input.number,
      input.connectionId,
      ...hostedReviewExecutionArgs(input)
    )
    return pr ? mapAzureDevOpsReview(pr) : null
  },
  createReview: createAzureDevOpsPullRequest
} satisfies ForgeProvider

const giteaForgeProvider = {
  id: 'gitea',
  supportsReviewCreation: true,
  copy: {
    shortLabel: 'PR',
    reviewLabel: 'pull request',
    titleLabel: 'Pull Request',
    providerName: 'Gitea',
    authInstruction: 'Set ORCA_GITEA_TOKEN'
  },
  async isAuthenticated(context) {
    if (!isGiteaReviewCreationAuthenticated()) {
      return false
    }
    const configuredBase = process.env.ORCA_GITEA_API_BASE_URL?.trim()
    if (configuredBase) {
      return (await getGiteaAuthStatus()).authenticated
    }
    const repo = await getGiteaRepoSlug(
      context.repoPath,
      context.connectionId,
      ...hostedReviewExecutionArgs(context)
    )
    return repo ? isGiteaTokenVerifiedAtBase(repo.apiBaseUrl) : isGiteaReviewCreationAuthenticated()
  },
  resolveRepository: (context) =>
    getGiteaRepoSlug(context.repoPath, context.connectionId, ...hostedReviewExecutionArgs(context)),
  async getReviewForBranch(input) {
    const pr = await getGiteaPullRequestForBranchOrThrow(
      input.repoPath,
      input.branch,
      input.linkedReviewNumber ?? null,
      input.connectionId,
      ...hostedReviewExecutionArgs(input)
    )
    return pr ? mapGiteaReview(pr) : null
  },
  async getReviewByNumber(input) {
    const pr = await getGiteaPullRequest(
      input.repoPath,
      input.number,
      input.connectionId,
      ...hostedReviewExecutionArgs(input)
    )
    return pr ? mapGiteaReview(pr) : null
  },
  createReview: createGiteaPullRequest
} satisfies ForgeProvider

// Why: provider order preserves existing branch-status behavior when remotes
// could be interpreted by more than one hosting integration.
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
  for (const provider of FORGE_PROVIDERS.slice(0, 4)) {
    if (await provider.resolveRepository(context)) {
      return provider
    }
  }
  const pluginProvider = await resolvePluginForgeProvider(context)
  if (pluginProvider) {
    return pluginProvider
  }
  if (await giteaForgeProvider.resolveRepository(context)) {
    return giteaForgeProvider
  }
  return null
}

export async function detectHostedReviewProvider(
  context: ForgeProviderRepositoryContext
): Promise<HostedReviewProvider> {
  return (await getForgeProviderForRepository(context))?.id ?? 'unsupported'
}

// Why: re-export the injected plugin forge provider accessors so consumers
// (hosted-review-creation, plugin-service) import them from one place.
export * from './plugin-forge-provider-bridge'
