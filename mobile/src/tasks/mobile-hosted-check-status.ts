import type { ProviderCheckSummary, PRMergeableState } from '../../../src/shared/types'
import { getProviderChecksLabel } from '../../../src/shared/provider-check-summary'

export type MobileHostedReviewStatus = {
  checksSummary?: ProviderCheckSummary
  reviewDecision?: string | null
  reviewRequests?: readonly unknown[]
  reviewerCount?: number
  mergeable?: PRMergeableState
  mergeStateStatus?: string | null
}

export function getHostedReviewLabel(item: MobileHostedReviewStatus): string {
  if (item.reviewDecision === 'approved' || item.reviewDecision === 'APPROVED') {
    return 'Approved'
  }
  if (item.reviewDecision === 'changes_requested' || item.reviewDecision === 'CHANGES_REQUESTED') {
    return 'Changes requested'
  }
  if (item.reviewDecision === 'review_required' || item.reviewDecision === 'REVIEW_REQUIRED') {
    return 'Review required'
  }
  const reviewerCount = item.reviewerCount ?? item.reviewRequests?.length
  return reviewerCount
    ? `${reviewerCount} reviewer${reviewerCount === 1 ? '' : 's'}`
    : 'No reviewers'
}

export function getHostedMergeLabel(item: MobileHostedReviewStatus): string {
  if (item.mergeable === 'CONFLICTING' || item.mergeStateStatus === 'BLOCKED') {
    return 'Conflicts'
  }
  if (item.mergeStateStatus === 'BEHIND' || item.checksSummary?.state === 'pending') {
    return 'Behind'
  }
  if (item.mergeable === 'MERGEABLE' || item.mergeStateStatus === 'CLEAN') {
    return 'Able to merge'
  }
  return 'Unknown'
}

export function getHostedChecksLabel(item: { checksSummary?: ProviderCheckSummary }): string {
  return getProviderChecksLabel(item.checksSummary)
}

export function getHostedReviewSignalTone(
  item: MobileHostedReviewStatus,
  signal: 'review' | 'checks' | 'merge'
): 'neutral' | 'success' | 'warning' | 'danger' {
  if (signal === 'review') {
    if (item.reviewDecision === 'approved' || item.reviewDecision === 'APPROVED') {
      return 'success'
    }
    if (
      item.reviewDecision === 'changes_requested' ||
      item.reviewDecision === 'CHANGES_REQUESTED'
    ) {
      return 'danger'
    }
    if (
      item.reviewDecision === 'review_required' ||
      item.reviewDecision === 'REVIEW_REQUIRED' ||
      item.reviewerCount !== undefined ||
      item.reviewRequests?.length
    ) {
      return 'warning'
    }
    return 'neutral'
  }
  if (signal === 'checks') {
    if (item.checksSummary?.state === 'success') {
      return 'success'
    }
    if (item.checksSummary?.state === 'failure') {
      return 'danger'
    }
    if (item.checksSummary?.state === 'pending') {
      return 'warning'
    }
    return 'neutral'
  }
  if (item.mergeable === 'CONFLICTING' || item.mergeStateStatus === 'BLOCKED') {
    return 'danger'
  }
  if (item.mergeStateStatus === 'BEHIND' || item.checksSummary?.state === 'pending') {
    return 'warning'
  }
  if (item.mergeable === 'MERGEABLE' || item.mergeStateStatus === 'CLEAN') {
    return 'success'
  }
  return 'neutral'
}
