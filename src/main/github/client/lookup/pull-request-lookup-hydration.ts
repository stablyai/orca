import type { OwnerRepo } from '../../gh-utils'
import type { GhExecOptions } from './../github-exec-scope'
import { detectRepositoryMergeMetadata } from './../detect/repository-merge-metadata'
import { mapPRState } from '../../mappers'
import {
  normalizePullRequestLookupData,
  type PullRequestLookupData
} from './pull-request-lookup-data'
import {
  readSharedPRCheckObservation,
  type PRProviderReadOptions
} from './shared-pr-provider-reads'
export async function hydratePullRequestLookupData(
  ownerRepo: OwnerRepo,
  data: PullRequestLookupData,
  ghOptions: GhExecOptions,
  executionScope: string,
  reads: PRProviderReadOptions = {}
): Promise<PullRequestLookupData> {
  const normalized = normalizePullRequestLookupData(data)
  const checks =
    data.checksUnavailable === false
      ? data.statusCheckRollup
      : await readSharedPRCheckObservation(
          ownerRepo,
          data.number,
          data.headRefOid,
          ghOptions,
          executionScope,
          reads
        )
  const hasRichMergeFields =
    'reviewDecision' in data || 'mergeStateStatus' in data || 'autoMergeRequest' in data
  const mergeMetadata =
    hasRichMergeFields && mapPRState(data.state, data.isDraft) === 'open'
      ? await detectRepositoryMergeMetadata(
          ownerRepo,
          normalized.stack?.baseRefName ?? normalized.baseRefName,
          ghOptions,
          executionScope
        )
      : undefined
  return {
    ...normalized,
    statusCheckRollup: checks ?? [],
    checksUnavailable: checks === undefined,
    ...(mergeMetadata ? { mergeQueueRequired: mergeMetadata.mergeQueueRequired } : {}),
    ...(mergeMetadata ? { autoMergeAllowed: mergeMetadata.autoMergeAllowed } : {}),
    ...(mergeMetadata?.mergeMethodSettings
      ? { mergeMethodSettings: mergeMetadata.mergeMethodSettings }
      : {})
  }
}
