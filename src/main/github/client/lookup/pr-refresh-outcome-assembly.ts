import type { PRRefreshOutcome } from '../../../../shared/github/pull-request-refresh-types'
import type {
  PRConflictSummary,
  PRMergeableState,
  GitHubPRStack
} from '../../../../shared/github/pull-request-types'
import { deriveCheckStatus, mapPRState } from '../../mappers'
import type { OwnerRepo } from '../../gh-utils'
import type { PullRequestLookupData } from './pull-request-lookup-data'

export function assemblePRRefreshFoundOutcome(args: {
  data: PullRequestLookupData
  dataRepo: OwnerRepo | null
  dataHeadRepo: OwnerRepo | null
  stack: GitHubPRStack | undefined
  mergeable: PRMergeableState
  stackMergeQueueRequired: boolean | null | undefined
  confirmedContainedHeadOid: string | null
  headDivergedFromMergedPRAtOid: string | null
  conflictSummary: PRConflictSummary | undefined
}): PRRefreshOutcome {
  const {
    data,
    dataRepo,
    dataHeadRepo,
    stack,
    mergeable,
    stackMergeQueueRequired,
    confirmedContainedHeadOid,
    headDivergedFromMergedPRAtOid,
    conflictSummary
  } = args
  return {
    kind: 'found',
    fetchedAt: Date.now(),
    pr: {
      number: data.number,
      title: data.title,
      state: mapPRState(data.state, data.isDraft),
      url: data.url,
      checksStatus: deriveCheckStatus(data.statusCheckRollup),
      updatedAt: data.updatedAt,
      mergeable,
      ...(data.reviewDecision !== undefined ? { reviewDecision: data.reviewDecision } : {}),
      ...(data.autoMergeEnabled !== undefined ? { autoMergeEnabled: data.autoMergeEnabled } : {}),
      ...(data.autoMergeAllowed !== undefined ? { autoMergeAllowed: data.autoMergeAllowed } : {}),
      ...(stackMergeQueueRequired !== undefined || data.mergeQueueRequired !== undefined
        ? {
            mergeQueueRequired:
              stackMergeQueueRequired !== undefined
                ? stackMergeQueueRequired
                : data.mergeQueueRequired
          }
        : {}),
      ...(data.mergeMethodSettings !== undefined
        ? { mergeMethodSettings: data.mergeMethodSettings }
        : {}),
      ...(data.mergeStateStatus !== undefined ? { mergeStateStatus: data.mergeStateStatus } : {}),
      ...(stack ? { stack } : {}),
      headSha: data.headRefOid,
      ...(confirmedContainedHeadOid ? { confirmedContainedHeadOid } : {}),
      ...(headDivergedFromMergedPRAtOid ? { headDivergedFromMergedPRAtOid } : {}),
      ...(data.baseRefName ? { baseRefName: data.baseRefName } : {}),
      ...(data.headRefName ? { headRefName: data.headRefName } : {}),
      prRepo: dataRepo ?? undefined,
      headRepo: dataHeadRepo ?? undefined,
      conflictSummary
    }
  }
}
