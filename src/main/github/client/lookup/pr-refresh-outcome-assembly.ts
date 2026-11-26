import {
  classifyPRCheckRollupResult,
  summarizePRCheckRollup
} from '../../../../shared/source-control/checks/pr-check-status'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type {
  PRConflictSummary,
  PRMergeableState,
  GitHubPRStack
} from '../../../../shared/github/pull-requests/pull-request-types'
import { mapPRState } from '../../api/github-read-response'
import type { GitHubRepositoryIdentity as OwnerRepo } from '../../../../shared/github/repositories/repository-identity'
import type { PullRequestLookupData } from './pull-request-lookup-data'
import type { GitHubRepositoryMergeMetadata } from './../detect/repository-merge-metadata-cache'

// Main-only: the full rollup stays off the renderer broadcast, beside the outcome it was read for.
const observedRollups = new WeakMap<PRRefreshOutcome, readonly unknown[]>()

/** The complete check rollup an outcome was assembled from; undefined when the read was partial. */
export function observedPRCheckRollup(outcome: PRRefreshOutcome): readonly unknown[] | undefined {
  return observedRollups.get(outcome)
}

export function assemblePRRefreshFoundOutcome(args: {
  data: PullRequestLookupData
  dataRepo: OwnerRepo | null
  dataHeadRepo: OwnerRepo | null
  stack: GitHubPRStack | undefined
  mergeable: PRMergeableState
  stackMergeMetadata: GitHubRepositoryMergeMetadata | undefined
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
    stackMergeMetadata,
    confirmedContainedHeadOid,
    headDivergedFromMergedPRAtOid,
    conflictSummary
  } = args
  const mergeMethodSettings = stackMergeMetadata?.mergeMethodSettings ?? data.mergeMethodSettings
  const checksSummary = summarizePRCheckRollup(data.statusCheckRollup)
  const checksReadComplete = data.checksUnavailable === false
  const checkResult = classifyPRCheckRollupResult(data.statusCheckRollup, checksReadComplete)
  const outcome: PRRefreshOutcome = {
    kind: 'found',
    fetchedAt: Date.now(),
    pr: {
      number: data.number,
      title: data.title,
      ...(data.labels ? { labels: data.labels.map(({ name, color }) => ({ name, color })) } : {}),
      state: mapPRState(data.state, data.isDraft),
      url: data.url,
      checksStatus:
        data.checksUnavailable !== false || checksSummary.state === 'none'
          ? 'neutral'
          : checksSummary.state,
      ...(data.checksUnavailable === false ? { checksSummary } : {}),
      updatedAt: data.updatedAt,
      mergeable,
      ...(data.reviewDecision !== undefined ? { reviewDecision: data.reviewDecision } : {}),
      ...(data.autoMergeEnabled !== undefined ? { autoMergeEnabled: data.autoMergeEnabled } : {}),
      ...(data.autoMergeAllowed !== undefined ? { autoMergeAllowed: data.autoMergeAllowed } : {}),
      ...(stackMergeMetadata || data.mergeQueueRequired !== undefined
        ? {
            mergeQueueRequired: stackMergeMetadata
              ? stackMergeMetadata.mergeQueueRequired
              : data.mergeQueueRequired
          }
        : {}),
      ...(mergeMethodSettings ? { mergeMethodSettings } : {}),
      ...(data.mergeStateStatus !== undefined ? { mergeStateStatus: data.mergeStateStatus } : {}),
      ...(stack ? { stack } : {}),
      headSha: data.headRefOid,
      ...(confirmedContainedHeadOid ? { confirmedContainedHeadOid } : {}),
      ...(headDivergedFromMergedPRAtOid ? { headDivergedFromMergedPRAtOid } : {}),
      ...(data.baseRefName ? { baseRefName: data.baseRefName } : {}),
      ...(data.headRefName ? { headRefName: data.headRefName } : {}),
      ...(data.baseRefOid ? { baseSha: data.baseRefOid } : {}),
      checksReadComplete,
      checksFinal: checkResult.final,
      failingCheckNames: checkResult.failingCheckNames,
      prRepo: dataRepo ?? undefined,
      headRepo: dataHeadRepo ?? undefined,
      conflictSummary
    }
  }
  if (checksReadComplete) {
    observedRollups.set(outcome, data.statusCheckRollup)
  }
  return outcome
}
