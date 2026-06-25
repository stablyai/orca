import type {
  CreateHostedReviewInput,
  CreateHostedReviewResult,
  HostedReviewInfo,
  HostedReviewProvider
} from '../../shared/hosted-review'
import {
  getAzureDevOpsPullRequest,
  getAzureDevOpsPullRequestForBranch,
  getAzureDevOpsRepoSlug
} from '../azure-devops/client'
import { createAzureDevOpsPullRequest } from '../azure-devops/pull-request-creation'
import {
  getBitbucketPullRequest,
  getBitbucketPullRequestForBranch,
  getBitbucketRepoSlug
} from '../bitbucket/client'
import {
  getGiteaPullRequest,
  getGiteaPullRequestForBranch,
  getGiteaRepoSlug
} from '../gitea/client'
import { createGiteaPullRequest } from '../gitea/pull-request-creation'
import { createGitHubPullRequest, getPRForBranch, getRepoSlug } from '../github/client'
import { getMergeRequest, getMergeRequestForBranch, getProjectSlug } from '../gitlab/client'
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
    const mr = await getMergeRequestForBranch(
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

const gitHubForgeProvider = {
  id: 'github',
  supportsReviewCreation: true,
  resolveRepository: (context) =>
    getRepoSlug(context.repoPath, context.connectionId, ...hostedReviewExecutionArgs(context)),
  async getReviewForBranch(input) {
    const fallbackReviewNumber =
      input.linkedReviewNumber == null ? (input.fallbackReviewNumber ?? null) : null
    const executionArgs = hostedReviewExecutionArgs(input)
    const pr =
      fallbackReviewNumber !== null
        ? await getPRForBranch(
            input.repoPath,
            input.branch,
            input.linkedReviewNumber ?? null,
            input.connectionId,
            fallbackReviewNumber,
            {
              ...executionArgs[0],
              acceptMergedFallbackPR: true
            }
          )
        : executionArgs.length > 0
          ? await getPRForBranch(
              input.repoPath,
              input.branch,
              input.linkedReviewNumber ?? null,
              input.connectionId,
              null,
              ...executionArgs
            )
          : await getPRForBranch(
              input.repoPath,
              input.branch,
              input.linkedReviewNumber ?? null,
              input.connectionId
            )
    return pr ? mapGitHubReview(pr) : null
  },
  async getReviewByNumber(input) {
    const executionArgs = hostedReviewExecutionArgs(input)
    const pr =
      executionArgs.length > 0
        ? await getPRForBranch(
            input.repoPath,
            '',
            input.number,
            input.connectionId,
            null,
            ...executionArgs
          )
        : await getPRForBranch(input.repoPath, '', input.number, input.connectionId)
    return pr ? mapGitHubReview(pr) : null
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
    const pr = await getBitbucketPullRequestForBranch(
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
    const pr = await getAzureDevOpsPullRequestForBranch(
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
    const pr = await getGiteaPullRequestForBranch(
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
