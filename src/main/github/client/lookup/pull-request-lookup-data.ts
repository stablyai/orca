import type {
  GitHubPRMergeMethodSettings,
  GitHubPRStack,
  PRMergeableState,
  PRReviewDecision
} from '../../../../shared/github/pull-request-types'
import { gitExecFileAsync, type OwnerRepo } from '../../gh-utils'
import type { GitAdmissionTier } from '../../../git/command-runner/git-exec-options'
import type { HostedReviewExecutionOptions } from '../../../source-control/hosted-review-git-options'
import { mapPRState } from '../../mappers'
import type { MergedPRCommitMembership } from '../../merged-pr-commit-membership'
import {
  normalizePRMergeable,
  normalizeReviewDecision,
  isAutoMergeEnabled
} from './../map/work-item-field-coercion'
import { requireReachableGitRoute } from '../../../providers/execution-host-provider-dispatch'
import { ownerRepoFromPullRequestUrl, sameOwnerRepo } from '../github-exec-scope'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host'
import { githubRepositoryWebHost } from '../../github-repository-host'
export type PullRequestLookupData = {
  number: number
  title: string
  state: string
  url: string
  statusCheckRollup: unknown[]
  updatedAt: string
  isDraft?: boolean
  mergeable: string
  reviewDecision?: PRReviewDecision | null
  autoMergeRequest?: unknown
  autoMergeEnabled?: boolean
  autoMergeAllowed?: boolean | null
  mergeQueueRequired?: boolean | null
  mergeMethodSettings?: GitHubPRMergeMethodSettings
  mergeStateStatus?: string | null
  baseRefName?: string
  headRefName?: string
  baseRefOid?: string
  headRefOid?: string
  isCrossRepository?: boolean
  headRepositoryOwner?: { login?: string } | null
  headRepository?: { name?: string } | null
  headDefaultBranchName?: string
  stack?: GitHubPRStack
  stackMetadataChecked?: boolean
}

export type PullRequestLookupPolicy = {
  accepts: (data: PullRequestLookupData, prRepo: OwnerRepo | null) => Promise<boolean>
  isRejected: (prRepo: OwnerRepo, number: number) => boolean
  rejectedPRUrls: ReadonlySet<string>
}

export type RestPullRequest = {
  number: number
  title: string
  state: string
  html_url?: string
  url?: string
  updated_at?: string
  draft?: boolean
  merged_at?: string | null
  mergeable?: boolean | null
  mergeable_state?: string | null
  auto_merge?: unknown
  base?: { ref?: string; sha?: string }
  head?: {
    ref?: string
    sha?: string
    repo?: { name?: string; owner?: { login?: string }; default_branch?: string } | null
    user?: { login?: string }
  }
  stack?: {
    number?: number
    position?: number
    size?: number
    base?: { ref?: string; sha?: string }
  } | null
}

export const PR_LOOKUP_JSON_FIELDS =
  'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid,headRepositoryOwner,headRepository,isCrossRepository'

export const PR_BRANCH_LIST_JSON_FIELDS =
  'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,baseRefName,headRefName,baseRefOid,headRefOid,headRepositoryOwner,headRepository,isCrossRepository'

export type GitHubPRBranchLookupOptions = HostedReviewExecutionOptions & {
  acceptMergedFallbackPR?: boolean
  // Supply the actual worktree head without probing a different main-repo checkout.
  currentHeadOid?: string | null
}

export function mapRestPRMergeable(pr: RestPullRequest): PRMergeableState {
  const mergeableState = pr.mergeable_state?.toLowerCase()
  if (mergeableState === 'dirty') {
    return 'CONFLICTING'
  }
  if (mergeableState === 'clean' || pr.mergeable === true) {
    return 'MERGEABLE'
  }
  return 'UNKNOWN'
}

export function derivePullRequestMergeable(data: PullRequestLookupData): PRMergeableState {
  const mergeable = normalizePRMergeable(data.mergeable)
  if (mergeable === 'CONFLICTING' || data.mergeStateStatus === 'DIRTY') {
    return 'CONFLICTING'
  }
  return mergeable ?? 'UNKNOWN'
}

export function mapRestPullRequest(pr: RestPullRequest): PullRequestLookupData {
  const stack =
    typeof pr.stack?.number === 'number' &&
    typeof pr.stack.position === 'number' &&
    typeof pr.stack.size === 'number' &&
    typeof pr.stack.base?.ref === 'string'
      ? {
          number: pr.stack.number,
          position: pr.stack.position,
          size: pr.stack.size,
          baseRefName: pr.stack.base.ref,
          ...(typeof pr.stack.base.sha === 'string' ? { baseSha: pr.stack.base.sha } : {})
        }
      : undefined
  return {
    number: pr.number,
    title: pr.title,
    state: pr.merged_at ? 'MERGED' : pr.state,
    url: pr.html_url ?? pr.url ?? '',
    statusCheckRollup: [],
    updatedAt: pr.updated_at ?? '',
    isDraft: pr.draft,
    mergeable: mapRestPRMergeable(pr),
    ...(pr.mergeable_state !== undefined
      ? { mergeStateStatus: pr.mergeable_state?.toUpperCase() ?? null }
      : {}),
    ...('auto_merge' in pr ? { autoMergeRequest: pr.auto_merge } : {}),
    baseRefName: pr.base?.ref,
    headRefName: pr.head?.ref,
    baseRefOid: pr.base?.sha,
    headRefOid: pr.head?.sha,
    headRepositoryOwner: pr.head?.repo?.owner ?? pr.head?.user,
    headRepository: pr.head?.repo,
    headDefaultBranchName: pr.head?.repo?.default_branch,
    stackMetadataChecked: true,
    ...(stack ? { stack } : {})
  }
}

export function pullRequestHeadRepository(
  data: PullRequestLookupData,
  prRepo: OwnerRepo | null
): OwnerRepo | null {
  const owner = data.headRepositoryOwner?.login?.trim()
  const repo = data.headRepository?.name?.trim()
  return owner && repo ? { owner, repo, ...(prRepo?.host ? { host: prRepo.host } : {}) } : null
}

export function pullRequestMatchesHeadRepository(
  data: PullRequestLookupData,
  prRepo: OwnerRepo | null,
  expectedHeadRepo: OwnerRepo | null
): boolean {
  const actualHeadRepo = pullRequestHeadRepository(data, prRepo)
  // A renamed repository still answers at its old remote URL; its own PRs report the new name.
  if (sameOwnerRepo(expectedHeadRepo, prRepo) && isSameRepositoryPullRequest(data, prRepo)) {
    return true
  }
  const owner = data.headRepositoryOwner?.login?.trim().toLowerCase()
  const baseRepo = ownerRepoFromPullRequestUrl(data.url)
  const isCrossRepository =
    data.isCrossRepository ??
    (actualHeadRepo && baseRepo
      ? !sameOwnerRepo(actualHeadRepo, baseRepo)
      : owner && baseRepo && owner !== baseRepo.owner.toLowerCase()
        ? true
        : undefined)
  if (!expectedHeadRepo) {
    return isCrossRepository !== true
  }
  const actualHostRepo = prRepo ?? baseRepo
  if (
    (actualHostRepo &&
      githubRepositoryWebHost(actualHostRepo).toLowerCase() !==
        githubRepositoryWebHost(expectedHeadRepo).toLowerCase()) ||
    (owner && owner !== expectedHeadRepo.owner.toLowerCase())
  ) {
    return false
  }
  return actualHeadRepo
    ? sameOwnerRepo(actualHeadRepo, expectedHeadRepo)
    : isCrossRepository !== true || Boolean(owner)
}

// Canonical PR URLs name the current base repository even when remote URLs are stale.
export function isSameRepositoryPullRequest(
  data: PullRequestLookupData,
  prRepo: OwnerRepo | null
): boolean {
  return sameOwnerRepo(
    pullRequestHeadRepository(data, prRepo),
    ownerRepoFromPullRequestUrl(data.url)
  )
}

export function isMergedImplicitPR(
  data: PullRequestLookupData,
  linkedPRNumber?: number | null
): boolean {
  // Historical merged branch matches alone do not establish current review context.
  return typeof linkedPRNumber !== 'number' && mapPRState(data.state, data.isDraft) === 'merged'
}

export function shouldHideMergedImplicitPR(
  data: PullRequestLookupData | null,
  linkedPRNumber: number | null | undefined,
  currentHeadOid: string | null
): boolean {
  if (!data || !isMergedImplicitPR(data, linkedPRNumber)) {
    return false
  }
  // Preserve historical merged reviews only when their head matches the current checkout.
  return !currentHeadOid || data.headRefOid !== currentHeadOid
}

export async function linkedMergedPRDivergedHeadOid(
  data: PullRequestLookupData | null,
  linkedPRNumber: number | null | undefined,
  currentHeadOid: string | null,
  containsHead: (data: PullRequestLookupData, headOid: string) => Promise<MergedPRCommitMembership>
): Promise<string | null> {
  if (
    typeof linkedPRNumber !== 'number' ||
    !data ||
    mapPRState(data.state, data.isDraft) !== 'merged' ||
    currentHeadOid === null ||
    data.headRefOid === currentHeadOid
  ) {
    return null
  }
  return (await containsHead(data, currentHeadOid)) === 'not-contained' ? currentHeadOid : null
}

export function normalizePullRequestLookupData(data: PullRequestLookupData): PullRequestLookupData {
  return {
    ...data,
    reviewDecision:
      data.reviewDecision !== undefined ? normalizeReviewDecision(data.reviewDecision) : undefined,
    autoMergeEnabled:
      data.autoMergeEnabled ??
      ('autoMergeRequest' in data ? isAutoMergeEnabled(data.autoMergeRequest) : undefined)
  }
}

export async function getCurrentHeadOid(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: { wslDistro?: string; admissionTier?: GitAdmissionTier } = {}
): Promise<string | null> {
  requireReachableGitRoute(getConnectionExecutionHostId(connectionId))
  try {
    const result = await gitExecFileAsync(['rev-parse', 'HEAD'], {
      cwd: repoPath,
      ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
      ...(localGitOptions.admissionTier ? { admissionTier: localGitOptions.admissionTier } : {})
    })
    return result.stdout.trim() || null
  } catch {
    return null
  }
}
