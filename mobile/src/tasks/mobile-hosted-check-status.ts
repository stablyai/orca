import type { ProviderCheckSummary, PRMergeableState } from '../../../src/shared/types'
import { t } from '@/i18n/mobile-i18n'

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
    return t('task.approved')
  }
  if (item.reviewDecision === 'changes_requested' || item.reviewDecision === 'CHANGES_REQUESTED') {
    return t('task.changes')
  }
  if (item.reviewDecision === 'review_required' || item.reviewDecision === 'REVIEW_REQUIRED') {
    return t('mobileHostedCheckStatus.review')
  }
  const reviewerCount = item.reviewerCount ?? item.reviewRequests?.length
  return reviewerCount
    ? t(
        reviewerCount === 1
          ? 'mobileHostedCheckStatus.reviewerCountReviewer'
          : 'mobileHostedCheckStatus.reviewerCountReviewers',
        { reviewerCount: reviewerCount }
      )
    : t('task.noReviewers')
}

export function getHostedMergeLabel(item: MobileHostedReviewStatus): string {
  if (item.mergeable === 'CONFLICTING' || item.mergeStateStatus === 'BLOCKED') {
    return t('task.conflicts')
  }
  if (item.mergeStateStatus === 'BEHIND' || item.checksSummary?.state === 'pending') {
    return t('task.behind')
  }
  if (item.mergeable === 'MERGEABLE' || item.mergeStateStatus === 'CLEAN') {
    return t('task.able')
  }
  return t('task.unknown')
}

export function getHostedChecksLabel(item: { checksSummary?: ProviderCheckSummary }): string {
  const summary = item.checksSummary
  if (!summary) {
    return t('task.checks')
  }
  if (summary.total === 0) {
    return t('mobilePrChipSummary.no')
  }
  if (summary.failed > 0) {
    return t('mobilePrChipSummary.failing', {
      failingCheckCount: summary.failed
    })
  }
  if (summary.pending > 0) {
    return t('mobileHostedCheckStatus.pending', {
      pendingCheckCount: summary.pending
    })
  }
  return summary.state === 'neutral'
    ? t('mobilePrChipSummary.unresolved')
    : t('mobileHostedCheckStatus.passed', {
        passedCheckCount: summary.passed,
        totalCheckCount: summary.total
      })
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
