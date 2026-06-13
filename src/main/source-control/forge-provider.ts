import type {
  CreateHostedReviewInput,
  CreateHostedReviewResult,
  HostedReviewInfo,
  HostedReviewProvider
} from '../../shared/hosted-review'
import { hostedReviewInfoFromGitHubPRInfo } from '../../shared/hosted-review-github'
import type { MRInfo, PRInfo } from '../../shared/types'
import {
  getAzureDevOpsPullRequest,
  getAzureDevOpsPullRequestForBranch,
  getAzureDevOpsRepoSlug
} from '../azure-devops/client'
import type { AzureDevOpsPullRequestInfo } from '../azure-devops/pull-request-mappers'
import {
  getBitbucketPullRequest,
  getBitbucketPullRequestForBranch,
  getBitbucketRepoSlug
} from '../bitbucket/client'
import type { BitbucketPullRequestInfo } from '../bitbucket/pull-request-mappers'
import {
  getGiteaPullRequest,
  getGiteaPullRequestForBranch,
  getGiteaRepoSlug
} from '../gitea/client'
import type { GiteaPullRequestInfo } from '../gitea/pull-request-mappers'
import { createGitHubPullRequest, getPRForBranch, getRepoSlug } from '../github/client'
import { getMergeRequest, getMergeRequestForBranch, getProjectSlug } from '../gitlab/client'
import { createGitLabMergeRequest } from '../gitlab/merge-request-creation'

export type ForgeProviderId = Exclude<HostedReviewProvider, 'unsupported'>

export type ForgeProviderRepositoryContext = {
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
    connectionId?: string | null
  ): Promise<CreateHostedReviewResult>
}

function mapGitHubReview(pr: PRInfo): HostedReviewInfo {
  return hostedReviewInfoFromGitHubPRInfo(pr)
}

function mapGitLabReviewState(state: MRInfo['state']): HostedReviewInfo['state'] {
  if (state === 'opened' || state === 'locked') {
    return 'open'
  }
  return state
}

function mapGitLabReview(mr: MRInfo): HostedReviewInfo {
  return {
    provider: 'gitlab',
    number: mr.number,
    title: mr.title,
    state: mapGitLabReviewState(mr.state),
    url: mr.url,
    status: mr.pipelineStatus,
    updatedAt: mr.updatedAt,
    mergeable: mr.mergeable,
    ...(mr.headSha ? { headSha: mr.headSha } : {}),
    ...(mr.conflictSummary ? { conflictSummary: mr.conflictSummary } : {})
  }
}

function mapBitbucketReview(pr: BitbucketPullRequestInfo): HostedReviewInfo {
  return {
    provider: 'bitbucket',
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.url,
    status: pr.status,
    updatedAt: pr.updatedAt,
    mergeable: pr.mergeable,
    ...(pr.headSha ? { headSha: pr.headSha } : {})
  }
}

function mapAzureDevOpsReview(pr: AzureDevOpsPullRequestInfo): HostedReviewInfo {
  return {
    provider: 'azure-devops',
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.url,
    status: pr.status,
    updatedAt: pr.updatedAt,
    mergeable: pr.mergeable,
    ...(pr.headSha ? { headSha: pr.headSha } : {})
  }
}

function mapGiteaReview(pr: GiteaPullRequestInfo): HostedReviewInfo {
  return {
    provider: 'gitea',
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.url,
    status: pr.status,
    updatedAt: pr.updatedAt,
    mergeable: pr.mergeable,
    ...(pr.headSha ? { headSha: pr.headSha } : {})
  }
}

const gitLabForgeProvider = {
  id: 'gitlab',
  supportsReviewCreation: true,
  resolveRepository: ({ repoPath, connectionId }) => getProjectSlug(repoPath, connectionId),
  async getReviewForBranch(input) {
    const mr = await getMergeRequestForBranch(
      input.repoPath,
      input.branch,
      input.linkedReviewNumber ?? null,
      input.connectionId
    )
    return mr ? mapGitLabReview(mr) : null
  },
  async getReviewByNumber(input) {
    const mr = await getMergeRequest(input.repoPath, input.number, input.connectionId)
    return mr ? mapGitLabReview(mr) : null
  },
  createReview: createGitLabMergeRequest
} satisfies ForgeProvider

const gitHubForgeProvider = {
  id: 'github',
  supportsReviewCreation: true,
  resolveRepository: ({ repoPath, connectionId }) => getRepoSlug(repoPath, connectionId),
  async getReviewForBranch(input) {
    const fallbackReviewNumber =
      input.linkedReviewNumber == null ? (input.fallbackReviewNumber ?? null) : null
    const pr =
      fallbackReviewNumber !== null
        ? await getPRForBranch(
            input.repoPath,
            input.branch,
            input.linkedReviewNumber ?? null,
            input.connectionId,
            fallbackReviewNumber
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
    const pr = await getPRForBranch(input.repoPath, '', input.number, input.connectionId)
    return pr ? mapGitHubReview(pr) : null
  },
  createReview: createGitHubPullRequest
} satisfies ForgeProvider

const bitbucketForgeProvider = {
  id: 'bitbucket',
  supportsReviewCreation: false,
  resolveRepository: ({ repoPath, connectionId }) => getBitbucketRepoSlug(repoPath, connectionId),
  async getReviewForBranch(input) {
    const pr = await getBitbucketPullRequestForBranch(
      input.repoPath,
      input.branch,
      input.linkedReviewNumber ?? null,
      input.connectionId
    )
    return pr ? mapBitbucketReview(pr) : null
  },
  async getReviewByNumber(input) {
    const pr = await getBitbucketPullRequest(input.repoPath, input.number, input.connectionId)
    return pr ? mapBitbucketReview(pr) : null
  }
} satisfies ForgeProvider

const azureDevOpsForgeProvider = {
  id: 'azure-devops',
  supportsReviewCreation: false,
  resolveRepository: ({ repoPath, connectionId }) => getAzureDevOpsRepoSlug(repoPath, connectionId),
  async getReviewForBranch(input) {
    const pr = await getAzureDevOpsPullRequestForBranch(
      input.repoPath,
      input.branch,
      input.linkedReviewNumber ?? null,
      input.connectionId
    )
    return pr ? mapAzureDevOpsReview(pr) : null
  },
  async getReviewByNumber(input) {
    const pr = await getAzureDevOpsPullRequest(input.repoPath, input.number, input.connectionId)
    return pr ? mapAzureDevOpsReview(pr) : null
  }
} satisfies ForgeProvider

const giteaForgeProvider = {
  id: 'gitea',
  supportsReviewCreation: false,
  resolveRepository: ({ repoPath, connectionId }) => getGiteaRepoSlug(repoPath, connectionId),
  async getReviewForBranch(input) {
    const pr = await getGiteaPullRequestForBranch(
      input.repoPath,
      input.branch,
      input.linkedReviewNumber ?? null,
      input.connectionId
    )
    return pr ? mapGiteaReview(pr) : null
  },
  async getReviewByNumber(input) {
    const pr = await getGiteaPullRequest(input.repoPath, input.number, input.connectionId)
    return pr ? mapGiteaReview(pr) : null
  }
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
