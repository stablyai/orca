import type { QueryClient, QueryKey } from '@tanstack/react-query'
import type { PRComment } from '../../../../src/shared/github/comments/comment-types'
import type { PRCheckDetail } from '../../../../src/shared/github/checks/check-types'
import {
  acceptPRCheckObservation,
  completePRCheckOwnerScope
} from '../../../../src/shared/github/checks/complete-pr-check-owner'
import type {
  GitHubAssignableUser,
  PRInfo
} from '../../../../src/shared/github/pull-requests/pull-request-types'
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../../../../src/shared/github/repositories/repository-identity'
import {
  matchesGitHubWorkItemTarget,
  resolveGitHubWorkItemTarget
} from '../../../../src/shared/github/work-items/work-item-target'
import type { GitHubWorkItemDetails } from '../../../../src/shared/github/work-items/work-item-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../src/shared/execution-host'
import { worktreeIdsEqual } from '../../../../src/shared/worktree/id'
import { defineHostQuery, type HostQuerySignal, type HostSignalEvent } from '../../query/host-query'
import {
  hostQueryKey,
  type HostQueryParams,
  type HostQueryTarget
} from '../../query/host-query-key'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { clearMobileWorktreeReviewLink, fetchWorktreeGitHubPRLink } from './mobile-pr-link'
import {
  fetchAssignableUsers,
  fetchGithubRepoSlug,
  fetchHostedReviewForBranch,
  fetchPRChecks,
  fetchPRForBranch,
  fetchWorkItemDetails
} from './github-pr-rpc'
import { githubPrRequestParams, type GitHubPrRepoSlug } from './github-pr-repo-slug'
import { githubPrCommentsRead } from './github-pr-read-operations'
import { loadPrBranchReview, type PrBranchReview } from './mobile-pr-sidebar-state'
import type { PrActionBusyKey } from './pr-actions-engine'

/** A PR repository as flat key params; null when the host decides (the workspace's own repo). */
export type PrRepoParams = { owner: string | null; name: string | null; host: string | null }

export function prRepoParams(repo: GitHubOwnerRepo | GitHubPrRepoSlug | null | undefined) {
  return {
    owner: repo?.owner ?? null,
    name: repo?.repo ?? null,
    host: repo?.host ?? null
  } satisfies PrRepoParams
}

function prRepoSlug(params: PrRepoParams): GitHubPrRepoSlug | null {
  return params.owner && params.name
    ? { owner: params.owner, repo: params.name, ...(params.host ? { host: params.host } : {}) }
    : null
}

/** The repository a PR's details and comments belong to: its own repo, or the one its URL names. */
export function prDetailsRepo(pr: PRInfo): GitHubOwnerRepo | null {
  return resolveGitHubWorkItemTarget({ ...pr, type: 'pr' })?.repository ?? null
}

export type PrBranchInput = { branch: string; head: string | null }
export type PrChecksInput = PrRepoParams & { number: number; head: string | null }
export type PrDetailsInput = PrRepoParams & { number: number }

/** What a write changed, so only that part is read again. */
export type PrSlice = 'summary' | 'checks' | 'details'

// State, merge and auto-merge live in the summary; reviewers also in the details; a rerun only moves checks.
export function prActionSlices(action: PrActionBusyKey): readonly PrSlice[] {
  switch (action.kind) {
    case 'reviewer':
      return ['summary', 'details']
    case 'rerun':
      return ['checks']
    case 'merge':
    case 'autoMerge':
    case 'state':
      return ['summary']
  }
}

/** The reads behind the shown PR, for the tab's polling and writes. */
export type PrQueryScope = {
  host: { hostId: string; client: RpcClient | null }
  target: HostQueryTarget
  branchInput: PrBranchInput | null
  checksInput: PrChecksInput | null
  detailsInput: PrDetailsInput | null
}

// Stand-in inputs for a disabled observer while there is no branch or PR yet.
export const NO_BRANCH: PrBranchInput = { branch: '', head: null }
export const NO_PR: PrDetailsInput = { owner: null, name: null, host: null, number: 0 }
export const NO_CHECKS: PrChecksInput = { ...NO_PR, head: null }

/** Whether the workspace's repo has a GitHub remote, which gates the PR tab. */
export const githubRepoSlugQuery = defineHostQuery({
  family: 'github.repoSlug',
  staleTime: 30 * 60_000,
  fetch: async (client, target, _input: HostQueryParams) => {
    const outcome = await fetchGithubRepoSlug(client, target.worktree ?? '')
    if (!outcome.ok) {
      throw new Error(outcome.error)
    }
    return outcome.result !== null
  }
})

// A summary read without a check rollup keeps the complete observation it already had for the same head.
function keepCheckObservation(
  next: PrBranchReview,
  previous: PrBranchReview | undefined
): PrBranchReview {
  if (next.kind !== 'found' || previous?.kind !== 'found' || next.pr.checksSummary) {
    return next
  }
  const scope = completePRCheckOwnerScope(next.pr)
  if (scope === undefined || scope !== completePRCheckOwnerScope(previous.pr)) {
    return next
  }
  const pr = acceptPRCheckObservation(next.pr, previous.pr, {
    scope,
    complete: true,
    current: true
  })
  return pr ? { ...next, pr } : next
}

// The desktop's own workspaces only: a relayed server's PR refreshes never reach this stream.
function namesThisCheckout(event: HostSignalEvent, target: HostQueryTarget): boolean {
  return (
    event.type === 'pullRequestChanged' &&
    target.exec === LOCAL_EXECUTION_HOST_ID &&
    worktreeIdsEqual(event.worktreeId, target.worktree ?? '')
  )
}

// Sent when a desktop PR refresh sees the PR change; changes no desktop refresh sees still wait for focus or the poll.
const pullRequestChangedSignal: HostQuerySignal = {
  events: ['pullRequestChanged'],
  floorMs: 1_000,
  matches: namesThisCheckout
}

export const prBranchReviewQuery = defineHostQuery({
  family: 'pr.forBranch',
  staleTime: 30_000,
  refetchOnWindowFocus: true,
  signal: pullRequestChangedSignal,
  fetch: async (client, target, input: PrBranchInput, previous: PrBranchReview | undefined, read) =>
    keepCheckObservation(
      await loadPrBranchReview(
        {
          fetchForBranch: (wt, args) => fetchHostedReviewForBranch(client, wt, args),
          fetchWorktreeGitHubPRLink: (wt) => fetchWorktreeGitHubPRLink(client, wt),
          clearWorktreeReviewLink: (wt, shouldApply) =>
            clearMobileWorktreeReviewLink(client, wt, shouldApply),
          fetchPRForBranch: (wt, args) => fetchPRForBranch(client, wt, args)
        },
        {
          worktreeId: target.worktree ?? '',
          branch: input.branch,
          headSha: input.head,
          // Only an action's read re-learns host status; revalidations reuse what this connection knows.
          refresh: read.live,
          previous
        }
      ),
      previous
    )
})

export const prChecksQuery = defineHostQuery({
  family: 'pr.checks',
  staleTime: 15_000,
  refetchOnWindowFocus: true,
  // The event also fires when the checks rollup moves, which the summary alone can't list.
  signal: pullRequestChangedSignal,
  fetch: async (
    client,
    target,
    input: PrChecksInput,
    _previous,
    read
  ): Promise<PRCheckDetail[]> => {
    const outcome = await fetchPRChecks(client, target.worktree ?? '', {
      prNumber: input.number,
      headSha: input.head,
      // Fork checks must use the PR's own repo identity.
      prRepo: prRepoSlug(input),
      refresh: read.live
    })
    if (!outcome.ok) {
      throw new Error(outcome.error)
    }
    return outcome.result
  }
})

// Body, comments, files and reviewers cost the host most of a PR read, so they are re-read only when the
// PR's updatedAt moves, on Refresh and after a write that changed them.
export const prDetailsQuery = defineHostQuery({
  family: 'pr.details',
  staleTime: Infinity,
  fetch: async (
    client,
    target,
    input: PrDetailsInput,
    _previous: GitHubWorkItemDetails | undefined,
    read
  ): Promise<GitHubWorkItemDetails> => {
    const repository = prRepoSlug(input)
    if (!repository) {
      throw new Error('Unable to identify this pull request. Open it again.')
    }
    const outcome = await fetchWorkItemDetails(client, target.worktree ?? '', {
      prNumber: input.number,
      prRepo: repository,
      refresh: read.live
    })
    if (!outcome.ok) {
      throw new Error(outcome.error)
    }
    if (
      !matchesGitHubWorkItemTarget(outcome.result?.item, {
        repository,
        type: 'pr',
        number: input.number
      })
    ) {
      throw new Error('Unable to load pull request details.')
    }
    // matchesGitHubWorkItemTarget rejects a null result.
    return outcome.result!
  }
})

// The desktop has no cache for this list, so one read per repository serves every reviewers sheet.
export const prAssignableUsersQuery = defineHostQuery({
  family: 'github.assignableUsers',
  staleTime: 10 * 60_000,
  fetch: async (client, target, input: PrRepoParams): Promise<GitHubAssignableUser[]> => {
    const repo = prRepoSlug(input)
    const outcome = await fetchAssignableUsers(client, target.worktree ?? '', repo)
    if (!outcome.ok) {
      throw new Error(outcome.error)
    }
    return outcome.result
  }
})

/** The PR's comments alone, bypassing the host's 60 s comment cache: what a comment write changed. */
export async function readPrComments(
  client: RpcClient,
  worktreeId: string,
  input: PrDetailsInput
): Promise<PRComment[]> {
  const method = githubPrCommentsRead.operation.method
  return githubPrCommentsRead.interpret(
    await githubPrCommentsRead.request(
      client,
      githubPrRequestParams(
        method,
        worktreeId,
        { prNumber: input.number, noCache: true },
        { prRepo: prRepoSlug(input) }
      )
    )
  )
}

/**
 * Puts re-read comments into the cached details. The host answers [] when every comment source failed,
 * so an empty list where comments were shown is not trusted: the whole details entry is re-read instead.
 */
export function acceptPrComments(
  queryClient: QueryClient,
  detailsKey: QueryKey,
  comments: PRComment[] | null
): void {
  const current = queryClient.getQueryData<GitHubWorkItemDetails>(detailsKey)
  if (!current) {
    return
  }
  if (comments === null || (comments.length === 0 && current.comments.length > 0)) {
    void queryClient.invalidateQueries({ queryKey: detailsKey, exact: true })
    return
  }
  queryClient.setQueryData<GitHubWorkItemDetails>(detailsKey, { ...current, comments })
}

/** Rewrites the cached details in place; a missing entry stays missing. */
export function patchPrDetails(
  queryClient: QueryClient,
  detailsKey: QueryKey,
  patch: (details: GitHubWorkItemDetails) => GitHubWorkItemDetails
): void {
  queryClient.setQueryData<GitHubWorkItemDetails>(detailsKey, (details) =>
    details ? patch(details) : details
  )
}

/** Rewrites the cached PR summary in place; a branch with no PR stays as it is. */
export function patchPrSummary(
  queryClient: QueryClient,
  branchKey: QueryKey,
  patch: (pr: PRInfo) => PRInfo
): void {
  queryClient.setQueryData<PrBranchReview>(branchKey, (review) =>
    review?.kind === 'found' ? { ...review, pr: patch(review.pr) } : review
  )
}

/** The cache keys a write patches: the shown PR's summary and details, when known. */
export function prQueryKeys(scope: PrQueryScope | null): {
  summaryKey: QueryKey | null
  detailsKey: QueryKey | null
} {
  const hostId = scope?.host.hostId ?? ''
  return {
    summaryKey: scope?.branchInput
      ? hostQueryKey(hostId, prBranchReviewQuery.family, scope.target, scope.branchInput)
      : null,
    detailsKey: scope?.detailsInput
      ? hostQueryKey(hostId, prDetailsQuery.family, scope.target, scope.detailsInput)
      : null
  }
}
