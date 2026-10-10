import { getPRConflictSummary } from '../../conflict-summary'
import type { ghRepoExecOptions, OwnerRepo } from '../../gh-utils'
import { hydrateGitHubPRStack } from '../../github-pr-stack'
import { detectRepositoryMergeMetadata } from './../detect/repository-merge-metadata'
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
}): Promise<{
  mergeable: ReturnType<typeof derivePullRequestMergeable>
  stack: PullRequestLookupData['stack']
  stackMergeQueueRequired: boolean | null | undefined
  conflictSummary: Awaited<ReturnType<typeof getPRConflictSummary>>
}> {
  const { data, dataRepo, repoPath, connectionId, localGitOptions, ghOptions, executionScope } =
    args
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
  const mergeable = derivePullRequestMergeable(data)
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
  const stackMergeQueueRequired =
    stack && dataRepo
      ? (
          await detectRepositoryMergeMetadata(
            dataRepo,
            stack.baseRefName,
            ghOptions,
            executionScope
          )
        ).mergeQueueRequired
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
  return { mergeable, stack, stackMergeQueueRequired, conflictSummary }
}
