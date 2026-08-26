import type { OwnerRepo } from '../../gh-utils'
import type { GhExecOptions } from './../github-exec-scope'
import { detectRepositoryMergeMetadata } from './../detect/repository-merge-metadata'
import { detectPullRequestMergeQueueEntry } from './../detect/pull-request-merge-queue-entry'
import { mapPRState } from '../../mappers'
import {
  normalizePullRequestLookupData,
  type PullRequestLookupData
} from './pull-request-lookup-data'
export async function hydratePullRequestLookupData(
  ownerRepo: OwnerRepo,
  data: PullRequestLookupData,
  ghOptions: GhExecOptions,
  executionScope: string
): Promise<PullRequestLookupData> {
  const normalized = normalizePullRequestLookupData(data)
  const hasRichMergeFields =
    'reviewDecision' in data || 'mergeStateStatus' in data || 'autoMergeRequest' in data
  const mergeMetadata = hasRichMergeFields
    ? await detectRepositoryMergeMetadata(
        ownerRepo,
        normalized.stack?.baseRefName ?? normalized.baseRefName,
        ghOptions,
        executionScope
      )
    : undefined
  // Why: the per-PR queue probe is a second GraphQL call, so only spend it where a
  // merge queue actually exists and the PR is still live enough to be sitting in it.
  const resolvedState = mapPRState(normalized.state, normalized.isDraft)
  const membership =
    mergeMetadata?.mergeQueueRequired === true && resolvedState === 'open'
      ? await detectPullRequestMergeQueueEntry(ownerRepo, normalized.number, ghOptions)
      : undefined
  return {
    ...normalized,
    ...(membership?.mergeQueueEntry ? { mergeQueueEntry: membership.mergeQueueEntry } : {}),
    ...(mergeMetadata ? { mergeQueueRequired: mergeMetadata.mergeQueueRequired } : {}),
    ...(mergeMetadata ? { autoMergeAllowed: mergeMetadata.autoMergeAllowed } : {}),
    ...(mergeMetadata?.mergeMethodSettings
      ? { mergeMethodSettings: mergeMetadata.mergeMethodSettings }
      : {})
  }
}
