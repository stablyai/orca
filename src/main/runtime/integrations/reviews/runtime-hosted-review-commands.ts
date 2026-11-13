import {
  preparePRBranchRead,
  readRecentPhonePROutcome
} from '../../../github/client/lookup/pr-for-branch-outcome'
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../../../../shared/github/repositories/repository-identity'
import type {
  GitHubPRRefreshReason,
  PRSnapshotReply
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { Repo } from '../../../../shared/repo-types'
import type { DeviceScope } from '../../../../shared/runtime-session-contracts'
import { getRepoSlug, getRepoUpstream } from '../../../github/client/fetch/repo-slug-upstream'
import {
  admissionTierForRefreshReason,
  bypassesFreshnessDelay
} from '../../../github/pull-requests/refresh/pr-refresh-candidate-policy'
import type { GitHubPRBranchLookupOptions } from '../../../github/client/lookup/pull-request-lookup-data'
import {
  runHostedPRRead,
  runHostedPRSnapshot
} from '../../../github/pull-requests/refresh/pr-refresh-coordinator'
import { HOSTED_PR_COMPLETION_WAIT_MS } from '../../../github/pull-requests/refresh/hosted-pr-read-jobs'
import {
  type CreateHostedReviewInput,
  type CreateHostedReviewResult,
  type CreateStackedHostedReviewInput,
  type CreateStackedHostedReviewResult,
  type HostedReviewCreationEligibility,
  type HostedReviewCreationEligibilityArgs,
  type HostedReviewForBranchReply,
  hostedReviewForBranchReply
} from '../../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { GitAdmissionTier } from '../../../../shared/rpc-contract/git-admission-tier-params'

import { readHostedReviewForBranch } from '../../../source-control/hosted-review'
import { getStoredRepoExecutionHostId } from '../../../workspaces/execution-host/repo-execution-host'
import { hostedReviewSshConnectionId } from '../../../source-control/hosted-review-execution-host'
import {
  createHostedReview,
  getHostedReviewCreationEligibility
} from '../../../source-control/hosted-review-creation'
import type { HostedReviewExecutionOptions } from '../../../source-control/hosted-review-git-options'
import { createStackedHostedReview } from '../../../source-control/stacked-hosted-review-creation'
import { guardWslUncPathAccess } from '../../../wsl/filesystem/wsl-unc-access-gate'

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
    userRefresh?: boolean,
    clientKind?: DeviceScope,
    signal?: AbortSignal,
    acceptRevalidationOnly = false,
    selected = false
  ): Promise<PRSnapshotReply> {
    const deadline = Date.now() + HOSTED_PR_COMPLETION_WAIT_MS
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
    if (reason && bypassesFreshnessDelay(reason)) {
      lookupOptions.resetQuietBackoff = true
    }
    if (acceptMergedFallbackPR === true) {
      lookupOptions.acceptMergedFallbackPR = true
    }
    if (typeof currentHeadOid === 'string' && currentHeadOid.trim().length > 0) {
      lookupOptions.currentHeadOid = currentHeadOid.trim()
    }
    const connectionId = hostedReviewSshConnectionId(getStoredRepoExecutionHostId(repo))
    // Legacy phone reads retain their narrower thirty-second reuse contract.
    if (clientKind === 'mobile' && reason === undefined) {
      const recent = await readRecentPhonePROutcome(
        repo.path,
        branch,
        linkedPRNumber ?? null,
        connectionId,
        fallbackPRNumber ?? null,
        lookupOptions
      )
      if (recent) {
        return recent
      }
    }
    const candidate = {
      cacheKey: `${repo.path}::${branch}`,
      repoKind: repo.kind ?? ('git' as const),
      repoId: repo.id,
      repoPath: repo.path,
      branch,
      connectionId,
      currentHeadOid: lookupOptions.currentHeadOid ?? null,
      linkedPRNumber: linkedPRNumber ?? null,
      fallbackPRNumber: linkedPRNumber == null ? (fallbackPRNumber ?? null) : null,
      localGitOptions: lookupOptions.localGitExecOptions,
      isSelected: reason === 'swr' && userRefresh !== true && selected
    }
    const prepared = await preparePRBranchRead(
      repo.path,
      branch,
      linkedPRNumber ?? null,
      connectionId,
      linkedPRNumber == null ? (fallbackPRNumber ?? null) : null,
      lookupOptions
    )
    if (reason === 'swr' && userRefresh !== true) {
      return runHostedPRSnapshot(candidate, prepared, deadline, signal, acceptRevalidationOnly)
    }
    return runHostedPRRead(candidate, prepared)
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
