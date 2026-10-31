import type {
  CreateHostedReviewInput,
  CreateHostedReviewResult,
  CreateStackedHostedReviewInput,
  CreateStackedHostedReviewResult,
  HostedReviewCreationEligibility,
  HostedReviewCreationEligibilityArgs,
  HostedReviewForBranchReply
} from '../../shared/hosted-review'
import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'
import type {
  GitHubPRRefreshReason,
  PRRefreshOutcome
} from '../../shared/github/pull-request-refresh-types'
import type { Repo } from '../../shared/repo-types'
import {
  getPRForBranchOutcome,
  getRepoSlug,
  getRepoUpstream,
  type GitHubPRBranchLookupOptions
} from '../github/client'
import { admissionTierForRefreshReason } from '../github/pr-refresh-candidate-policy'
import type { GitAdmissionTier } from '../git/command-runner/git-exec-options'
import { hostedReviewForBranchReply } from '../../shared/hosted-review'
import { readHostedReviewForBranch } from '../source-control/hosted-review'
import { getStoredRepoExecutionHostId } from '../repo-execution-host'
import { hostedReviewSshConnectionId } from '../source-control/hosted-review-execution-host'
import {
  createHostedReview,
  getHostedReviewCreationEligibility
} from '../source-control/hosted-review-creation'
import type { HostedReviewExecutionOptions } from '../source-control/hosted-review-git-options'
import { createStackedHostedReview } from '../source-control/stacked-hosted-review-creation'
import { guardWslUncPathAccess } from '../wsl/wsl-unc-access-gate'

type HostedReviewTargetArgs = { repoSelector: string; worktreeSelector?: string }

type RuntimeHostedReviewCommandsDeps = {
  resolveRepo: (selector: string) => Promise<Repo>
  resolveTarget: (args: HostedReviewTargetArgs) => Promise<{ repo: Repo; repoPath: string }>
  getExecutionOptions: (
    repo: Repo,
    admissionTier?: GitAdmissionTier
  ) => HostedReviewExecutionOptions | undefined
  recordCreated: (repoId: string, number: number, url: string) => void
}

export class RuntimeHostedReviewCommands {
  constructor(private readonly deps: RuntimeHostedReviewCommandsDeps) {}

  async getRepoSlug(repoSelector: string): Promise<GitHubOwnerRepo | null> {
    const repo = await this.deps.resolveRepo(repoSelector)
    const options = this.deps.getExecutionOptions(repo)
    const connectionId = hostedReviewSshConnectionId(getStoredRepoExecutionHostId(repo))
    return options
      ? getRepoSlug(repo.path, connectionId, options)
      : getRepoSlug(repo.path, connectionId)
  }

  async getRepoUpstream(repoSelector: string): Promise<GitHubOwnerRepo | null> {
    const repo = await this.deps.resolveRepo(repoSelector)
    const options = this.deps.getExecutionOptions(repo)
    const connectionId = hostedReviewSshConnectionId(getStoredRepoExecutionHostId(repo))
    return options
      ? getRepoUpstream(repo.path, connectionId, options)
      : getRepoUpstream(repo.path, connectionId)
  }

  async getRepoPRForBranch(
    repoSelector: string,
    branch: string,
    linkedPRNumber?: number | null,
    fallbackPRNumber?: number | null,
    acceptMergedFallbackPR?: boolean,
    currentHeadOid?: string | null,
    reason?: GitHubPRRefreshReason,
    userRefresh?: boolean
  ): Promise<PRRefreshOutcome> {
    const repo = await this.deps.resolveRepo(repoSelector)
    const lookupOptions: GitHubPRBranchLookupOptions = {
      ...this.deps.getExecutionOptions(
        repo,
        reason ? admissionTierForRefreshReason(reason) : undefined
      )
    }
    if (userRefresh === true) {
      lookupOptions.userRefresh = true
    }
    if (acceptMergedFallbackPR === true) {
      lookupOptions.acceptMergedFallbackPR = true
    }
    if (typeof currentHeadOid === 'string' && currentHeadOid.trim().length > 0) {
      lookupOptions.currentHeadOid = currentHeadOid.trim()
    }
    const lookupOptionArgs: [] | [GitHubPRBranchLookupOptions] =
      Object.keys(lookupOptions).length > 0 ? [lookupOptions] : []
    return getPRForBranchOutcome(
      repo.path,
      branch,
      linkedPRNumber ?? null,
      hostedReviewSshConnectionId(getStoredRepoExecutionHostId(repo)),
      linkedPRNumber == null ? (fallbackPRNumber ?? null) : null,
      ...lookupOptionArgs
    )
  }

  async getHostedReviewForBranch(args: {
    repoSelector: string
    branch: string
    admissionTier?: GitAdmissionTier
    currentHeadOid?: string | null
    active?: boolean
    force?: boolean
    userRefresh?: boolean
    reportReadOutcome?: boolean
    linkedGitHubPR?: number | null
    fallbackGitHubPR?: number | null
    linkedGitLabMR?: number | null
    linkedBitbucketPR?: number | null
    linkedAzureDevOpsPR?: number | null
    linkedGiteaPR?: number | null
  }): Promise<HostedReviewForBranchReply> {
    const repo = await this.deps.resolveRepo(args.repoSelector)
    const executionOptions = this.deps.getExecutionOptions(repo, args.admissionTier ?? 'background')
    const read = await readHostedReviewForBranch({
      repoPath: repo.path,
      executionHostId: getStoredRepoExecutionHostId(repo),
      branch: args.branch,
      currentHeadOid: args.currentHeadOid ?? null,
      ...(args.active === true ? { active: true } : {}),
      ...(args.force === true ? { force: true } : {}),
      ...(args.userRefresh === true ? { userRefresh: true } : {}),
      linkedGitHubPR: args.linkedGitHubPR ?? null,
      fallbackGitHubPR: args.linkedGitHubPR == null ? (args.fallbackGitHubPR ?? null) : null,
      linkedGitLabMR: args.linkedGitLabMR ?? null,
      linkedBitbucketPR: args.linkedBitbucketPR ?? null,
      linkedAzureDevOpsPR: args.linkedAzureDevOpsPR ?? null,
      linkedGiteaPR: args.linkedGiteaPR ?? null,
      ...executionOptions
    })
    const review = read.review
    if (review?.provider === 'github') {
      this.deps.recordCreated(repo.id, review.number, review.url)
    }
    return hostedReviewForBranchReply(read, args.reportReadOutcome)
  }

  async getHostedReviewCreationEligibility(
    args: Omit<HostedReviewCreationEligibilityArgs, 'repoPath'> & HostedReviewTargetArgs
  ): Promise<HostedReviewCreationEligibility> {
    const { repo, repoPath } = await this.deps.resolveTarget(args)
    const executionOptions = this.deps.getExecutionOptions(repo, 'interactive')
    // A paired client's Source Control asks on mount; it must not start a stopped distro (E9).
    return guardWslUncPathAccess(
      repo.path,
      () =>
        getHostedReviewCreationEligibility({
          repoPath,
          executionHostId: getStoredRepoExecutionHostId(repo),
          branch: args.branch,
          base: args.base ?? null,
          hasUncommittedChanges: args.hasUncommittedChanges,
          hasUpstream: args.hasUpstream,
          ahead: args.ahead,
          behind: args.behind,
          linkedGitHubPR: args.linkedGitHubPR ?? null,
          fallbackGitHubPR: args.linkedGitHubPR == null ? (args.fallbackGitHubPR ?? null) : null,
          linkedGitLabMR: args.linkedGitLabMR ?? null,
          linkedBitbucketPR: args.linkedBitbucketPR ?? null,
          linkedAzureDevOpsPR: args.linkedAzureDevOpsPR ?? null,
          linkedGiteaPR: args.linkedGiteaPR ?? null,
          ...executionOptions
        }),
      {
        wake: args.wakeWslDistro === true,
        wslDistro: executionOptions?.localGitExecOptions?.wslDistro
      }
    )
  }

  async createHostedReview(
    args: CreateHostedReviewInput & HostedReviewTargetArgs
  ): Promise<CreateHostedReviewResult> {
    const { repo, repoPath } = await this.deps.resolveTarget(args)
    const executionOptions = this.deps.getExecutionOptions(repo, 'interactive')
    const input = {
      provider: args.provider,
      base: args.base,
      head: args.head,
      title: args.title,
      body: args.body,
      draft: args.draft,
      ...(args.useTemplate !== undefined ? { useTemplate: args.useTemplate } : {})
    }
    const executionHostId = getStoredRepoExecutionHostId(repo)
    const result = executionOptions
      ? await createHostedReview(repoPath, input, executionHostId, executionOptions)
      : await createHostedReview(repoPath, input, executionHostId)
    if (result.ok) {
      this.deps.recordCreated(repo.id, result.number, result.url)
    }
    return result
  }

  async createStackedHostedReview(
    args: CreateStackedHostedReviewInput & HostedReviewTargetArgs
  ): Promise<CreateStackedHostedReviewResult> {
    const { repo, repoPath } = await this.deps.resolveTarget(args)
    const executionOptions = this.deps.getExecutionOptions(repo, 'interactive')
    const result = await createStackedHostedReview(
      repoPath,
      {
        provider: args.provider,
        base: args.base,
        head: args.head,
        title: args.title,
        body: args.body,
        draft: args.draft,
        ...(args.useTemplate !== undefined ? { useTemplate: args.useTemplate } : {})
      },
      getStoredRepoExecutionHostId(repo),
      executionOptions ?? {}
    )
    if (result.ok) {
      this.deps.recordCreated(repo.id, result.number, result.url)
    }
    return result
  }
}
