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
import {
  getGiteaPullRequest,
  getGiteaPullRequestForBranchOrThrow,
  getGiteaRepoSlug
} from '../gitea/client'
import { createGiteaPullRequest } from '../gitea/pull-request-creation'
import { createGitHubPullRequest, getPRForBranchOutcome, getRepoSlug } from '../github/client'
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

export type ForgeProvider = {
  id: ForgeProviderId
  supportsReviewCreation: boolean
  resolveRepository(context: ForgeProviderRepositoryContext): Promise<unknown | null>
  getReviewForBranch(input: ForgeReviewForBranchInput): Promise<HostedReviewInfo | null>
  getReviewByNumber(input: ForgeReviewByNumberInput): Promise<HostedReviewInfo | null>
  createReview?(
    repoPath: string,
    input: CreateHostedReviewInput,
    connectionId?: string | null,
    options?: HostedReviewExecutionOptions
  ): Promise<CreateHostedReviewResult>
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

const gitHubForgeProvider = {
  id: 'github',
  supportsReviewCreation: true,
  // Why: getRepoSlug resolves hosted identities — GHES remotes are claimed when
  // gh is authenticated to their host (the same signal GitLab uses for
  // self-hosted instances), so detection never falls through to Gitea (#8312).
  resolveRepository: async (context) =>
    getRepoSlug(context.repoPath, context.connectionId, ...hostedReviewExecutionArgs(context)),
  async getReviewForBranch(input) {
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
  supportsReviewCreation: false,
  resolveRepository: (context) =>
    getBitbucketRepoSlug(
      context.repoPath,
      context.connectionId,
      ...hostedReviewExecutionArgs(context)
    ),
  async getReviewForBranch(input) {
    // Why: surface a real lookup failure so eligibility records `unavailable`
    // instead of a false "No pull request found".
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
  }
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
    // Why: surface a real lookup failure so eligibility records `unavailable`
    // instead of a false "No pull request found".
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
  resolveRepository: (context) =>
    getGiteaRepoSlug(context.repoPath, context.connectionId, ...hostedReviewExecutionArgs(context)),
  async getReviewForBranch(input) {
    // Why: surface a real lookup failure so eligibility records `unavailable`
    // instead of a false "No pull request found".
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
