import { mapPRState } from '../../api/github-read-response'
import { getPRConflictSummary } from '../../pull-requests/conflicts/conflict-summary'
import type { ghRepoExecOptions } from '../../repositories/github-repository-identity'
import type { GitHubRepositoryIdentity as OwnerRepo } from '../../../../shared/github/repositories/repository-identity'
import { hydrateGitHubPRStack } from '../../pull-requests/stacks/github-pr-stack'
import { detectRepositoryMergeMetadata } from './../detect/repository-merge-metadata'
import type { GitHubRepositoryMergeMetadata } from './../detect/repository-merge-metadata-cache'
import type { ReviewMergeQueueEntry } from '../../../../shared/github/pull-requests/merge/review-merge-queue-entry'
import {
  fetchPullRequestMergeQueueEntry,
  shouldFetchPullRequestMergeQueueEntry
} from './../detect/pull-request-merge-queue-entry'
import { derivePullRequestMergeable, type PullRequestLookupData } from './pull-request-lookup-data'
import { getCachedGitHubPRStackSummary } from './pr-stack-summary-cache'

export async function derivePRRefreshData(args: {
  data: PullRequestLookupData
  dataRepo: OwnerRepo | null
  repoPath: string
  connectionId?: string | null
  localGitOptions: { wslDistro?: string }
  ghOptions: ReturnType<typeof ghRepoExecOptions>
  executionScope: string
  usedExactNumberLookup: boolean
  includeDerivedData?: boolean
}): Promise<{
  mergeable: ReturnType<typeof derivePullRequestMergeable>
  stack: PullRequestLookupData['stack']
  stackMergeMetadata: GitHubRepositoryMergeMetadata | undefined
  mergeQueueEntry: ReviewMergeQueueEntry | null | undefined
  conflictSummary: Awaited<ReturnType<typeof getPRConflictSummary>>
}> {
  const { data, dataRepo, repoPath, connectionId, localGitOptions, ghOptions, executionScope } =
    args
  const mergeable = derivePullRequestMergeable(data)
  if (args.includeDerivedData === false) {
    return {
      mergeable,
      stack: undefined,
      stackMergeMetadata: undefined,
      mergeQueueEntry: undefined,
      conflictSummary: undefined
    }
  }
  if (!data.stackMetadataChecked && dataRepo && args.usedExactNumberLookup) {
    try {
      data.stack = await getCachedGitHubPRStackSummary(
        dataRepo,
        data.number,
        ghOptions,
        executionScope
      )
      data.stackMetadataChecked = true
    } catch {
      // Stack metadata is additive; exact PR lookup remains usable without it.
    }
  }
  const stack =
    data.stack && dataRepo
      ? await hydrateGitHubPRStack(
          dataRepo,
          data.number,
          data.stack,
          ghOptions,
          data.updatedAt,
          executionScope
        )
      : data.stack
  // A stack merges into its base branch, so that branch's queue and rules apply.
  const stackMergeMetadata =
    stack && dataRepo
      ? await detectRepositoryMergeMetadata(dataRepo, stack.baseRefName, ghOptions, executionScope)
      : undefined
  const mergeQueueEntry =
    dataRepo &&
    shouldFetchPullRequestMergeQueueEntry({
      state: mapPRState(data.state, data.isDraft),
      mergeQueueRequired: stackMergeMetadata
        ? stackMergeMetadata.mergeQueueRequired
        : data.mergeQueueRequired
    })
      ? await fetchPullRequestMergeQueueEntry(dataRepo, data.number, ghOptions)
      : undefined
  const conflictSummary =
    !connectionId &&
    mergeable === 'CONFLICTING' &&
    data.baseRefName &&
    data.baseRefOid &&
    data.headRefOid
      ? await getPRConflictSummary(
          repoPath,
          data.baseRefName,
          data.baseRefOid,
          data.headRefOid,
          localGitOptions
        )
      : undefined
  return { mergeable, stack, stackMergeMetadata, mergeQueueEntry, conflictSummary }
}
