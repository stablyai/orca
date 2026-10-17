import type { OwnerRepo } from '../../gh-utils'
import type { GhExecOptions } from './../github-exec-scope'
import { detectRepositoryMergeMetadata } from './../detect/repository-merge-metadata'
import { readPullRequestInMergeQueue } from './pull-request-merge-queue-membership'
import {
  normalizePullRequestLookupData,
  type PullRequestLookupData
} from './pull-request-lookup-data'
export async function hydratePullRequestLookupData(
  ownerRepo: OwnerRepo,
  data: PullRequestLookupData,
  ghOptions: GhExecOptions,
  executionScope: string,
  options?: { readQueueMembership?: boolean }
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
  const inMergeQueue =
    options?.readQueueMembership === true && mergeMetadata?.mergeQueueRequired === true
      ? await readPullRequestInMergeQueue(ownerRepo, normalized.number, ghOptions)
      : undefined
  return {
    ...normalized,
    ...(mergeMetadata ? { mergeQueueRequired: mergeMetadata.mergeQueueRequired } : {}),
    ...(mergeMetadata ? { autoMergeAllowed: mergeMetadata.autoMergeAllowed } : {}),
    ...(mergeMetadata?.mergeMethodSettings
      ? { mergeMethodSettings: mergeMetadata.mergeMethodSettings }
      : {}),
    ...(inMergeQueue !== undefined ? { inMergeQueue } : {})
  }
}
