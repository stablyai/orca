import type {
  PRMergeableState,
  ProviderCheckSummary
} from '../../../src/shared/github/pull-request-types'
import { translate } from '../i18n/mobile-i18n'
import { resolveGitHubPRMergeState } from '../../../src/shared/github/pull-request-merge-state'
import { getProviderChecksLabel } from '../../../src/shared/provider-check-summary'

export type MobileHostedReviewStatus = {
  state?: string
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

function hostedMergeState(item: MobileHostedReviewStatus) {
  return resolveGitHubPRMergeState({
    state:
      item.state === 'merged' || item.state === 'closed' || item.state === 'draft'
        ? item.state
        : 'open',
    mergeable: item.mergeable,
    mergeStateStatus: item.mergeStateStatus,
    checksSummary: item.checksSummary
  }).kind
}

export function getHostedMergeLabel(item: MobileHostedReviewStatus): string | null {
  switch (hostedMergeState(item)) {
    case 'merged':
      return translate('tasks.hostedMerge.merged', 'Merged')
    case 'closed':
      return translate('tasks.hostedMerge.closed', 'Closed')
    case 'conflicts':
      return translate('tasks.hostedMerge.conflicts', 'Conflicts')
    case 'behind':
      return translate('tasks.hostedMerge.behind', 'Behind')
    case 'blocked':
      return translate('tasks.hostedMerge.blocked', 'Blocked')
    case 'mergeable_checks_pending':
      return translate('tasks.hostedMerge.checksPending', 'Checks pending')
    case 'mergeable':
    case 'mergeable_checks_failed':
    case 'mergeable_checks_passed':
      return translate('tasks.hostedMerge.ableToMerge', 'Able to merge')
    case 'merge_status_unavailable':
    case 'checks_passed':
    case 'draft':
      return null
    case 'review_required':
    case 'changes_requested':
    case 'merge_queue':
    case 'merge_queue_auto_merge_on':
    case 'checking':
      return translate('tasks.hostedMerge.unknown', 'Unknown')
  }
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
  switch (hostedMergeState(item)) {
    case 'conflicts':
    case 'blocked':
      return 'danger'
    case 'behind':
    case 'mergeable_checks_pending':
      return 'warning'
    case 'mergeable':
    case 'mergeable_checks_failed':
    case 'mergeable_checks_passed':
      return 'success'
    case 'merged':
    case 'closed':
    case 'draft':
    case 'review_required':
    case 'changes_requested':
    case 'merge_queue':
    case 'merge_queue_auto_merge_on':
    case 'merge_status_unavailable':
    case 'checks_passed':
    case 'checking':
      return 'neutral'
  }
}
