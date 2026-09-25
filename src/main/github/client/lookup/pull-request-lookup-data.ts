import type {
  GitHubPRMergeMethodSettings,
  GitHubPRStack,
  PRMergeableState,
  PRReviewDecision
} from '../../../../shared/github/pull-request-types'
import { gitExecFileAsync } from '../../gh-utils'
import type { GitAdmissionTier } from '../../../git/command-runner/git-exec-options'
import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../../../providers/ssh-git-dispatch'
import type { HostedReviewExecutionOptions } from '../../../source-control/hosted-review-git-options'
import { mapPRState } from '../../mappers'
import {
  normalizePRMergeable,
  normalizeReviewDecision,
  isAutoMergeEnabled
} from './../map/work-item-field-coercion'
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
  stack?: GitHubPRStack
  stackMetadataChecked?: boolean
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
  base?: { ref?: string; sha?: string }
  head?: { ref?: string; sha?: string }
  stack?: {
    number?: number
    position?: number
    size?: number
    base?: { ref?: string; sha?: string }
  } | null
}

export const PR_LOOKUP_JSON_FIELDS =
  'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'

export const PR_BRANCH_LIST_JSON_FIELDS =
  'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,baseRefName,headRefName,baseRefOid,headRefOid'

export type GitHubPRBranchLookupOptions = HostedReviewExecutionOptions & {
  acceptMergedFallbackPR?: boolean
  // Why: compare merged implicit PRs against the worktree HEAD, not main repo HEAD, without a worktree-scoped git call.
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
    baseRefName: pr.base?.ref,
    headRefName: pr.head?.ref,
    baseRefOid: pr.base?.sha,
    headRefOid: pr.head?.sha,
    stackMetadataChecked: true,
    ...(stack ? { stack } : {})
  }
}

export function isMergedImplicitPR(
  data: PullRequestLookupData,
  linkedPRNumber?: number | null
): boolean {
  // Why: a merged PR without an explicit link is just a historical branch match, not implicit review context.
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
  // Why: keep hiding historical merged branch matches, but preserve the merged PR for the exact commit currently checked out.
  return !currentHeadOid || data.headRefOid !== currentHeadOid
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
  const provider = connectionId ? getSshGitProvider(connectionId) : null
  if (connectionId && !provider) {
    throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
  }
  if (provider) {
    const result = await provider.exec(['rev-parse', 'HEAD'], repoPath)
    return result.stdout.trim() || null
  }
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
