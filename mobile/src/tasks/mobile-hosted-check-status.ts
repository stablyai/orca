import type { ProviderCheckSummary } from '../../../src/shared/types'

export type MobileHostedReviewStatus = {
  checksSummary?: ProviderCheckSummary
  reviewDecision?: string | null
  reviewRequests?: readonly unknown[]
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  mergeStateStatus?: string | null
}

export function getHostedChecksLabel(item: { checksSummary?: ProviderCheckSummary }): string {
  const summary = item.checksSummary
  if (!summary) {
    return 'Checks'
  }
  if (summary.total === 0) {
    return 'No checks'
  }
  if (summary.failed > 0) {
    return `${summary.failed} failing`
  }
  if (summary.pending > 0) {
    return `${summary.pending} pending`
  }
  return summary.state === 'neutral'
    ? 'Unresolved checks'
    : `${summary.passed}/${summary.total} passed`
}

export function getHostedReviewSignalTone(
  item: MobileHostedReviewStatus,
  signal: 'review' | 'checks' | 'merge'
): 'neutral' | 'success' | 'warning' | 'danger' {
  if (signal === 'review') {
    if (item.reviewDecision === 'APPROVED') {
      return 'success'
    }
    if (item.reviewDecision === 'CHANGES_REQUESTED') {
      return 'danger'
    }
    if (item.reviewRequests && item.reviewRequests.length > 0) {
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
