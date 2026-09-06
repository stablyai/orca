import type {
  PRMergeableState,
  ProviderCheckSummary
} from '../../../src/shared/github/pull-request-types'
import {
  getProviderChecksLabel,
  getProviderChecksPresentationState
} from '../../../src/shared/provider-check-summary'

export type MobileHostedReviewStatus = {
  checksSummary?: ProviderCheckSummary
  reviewDecision?: string | null
  reviewRequests?: readonly unknown[]
  reviewerCount?: number
  mergeable?: PRMergeableState
  mergeStateStatus?: string | null
}

type HostedReviewSignalTone = 'neutral' | 'success' | 'warning' | 'danger'

type HostedMergePresentation = {
  label: string
  tone: HostedReviewSignalTone
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

function getHostedMergePresentation(item: MobileHostedReviewStatus): HostedMergePresentation {
  if (item.mergeable === 'CONFLICTING' || item.mergeStateStatus === 'BLOCKED') {
    return { label: 'Conflicts', tone: 'danger' }
  }
  const checksState = getProviderChecksPresentationState(item.checksSummary)
  if (item.mergeStateStatus === 'BEHIND' || checksState === 'pending') {
    return { label: 'Behind', tone: 'warning' }
  }
  if (checksState === 'failure') {
    return { label: 'Checks failed', tone: 'danger' }
  }
  if (checksState === 'action_required') {
    return { label: 'Action required', tone: 'warning' }
  }
  if (item.mergeable === 'MERGEABLE' || item.mergeStateStatus === 'CLEAN') {
    return { label: 'Able to merge', tone: 'success' }
  }
  return { label: 'Unknown', tone: 'neutral' }
}

export function getHostedMergeLabel(item: MobileHostedReviewStatus): string {
  return getHostedMergePresentation(item).label
}

export function getHostedChecksLabel(item: { checksSummary?: ProviderCheckSummary }): string {
  return getProviderChecksLabel(item.checksSummary)
}

export function getHostedReviewSignalTone(
  item: MobileHostedReviewStatus,
  signal: 'review' | 'checks' | 'merge'
): HostedReviewSignalTone {
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
    const state = getProviderChecksPresentationState(item.checksSummary)
    if (state === 'success') {
      return 'success'
    }
    if (state === 'failure') {
      return 'danger'
    }
    if (state === 'action_required' || state === 'pending') {
      return 'warning'
    }
    return 'neutral'
  }
  return getHostedMergePresentation(item).tone
}
