import type { PRInfo } from '../../../../src/shared/types'

type MobilePRAutoMergeAvailabilityInput = Pick<
  PRInfo,
  | 'state'
  | 'mergeable'
  | 'mergeStateStatus'
  | 'reviewDecision'
  | 'autoMergeEnabled'
  | 'autoMergeAllowed'
  | 'mergeQueueRequired'
>

function isConflicting(item: MobilePRAutoMergeAvailabilityInput): boolean {
  return item.mergeable === 'CONFLICTING' || item.mergeStateStatus === 'DIRTY'
}

function hasReviewRequirement(item: MobilePRAutoMergeAvailabilityInput): boolean {
  return item.reviewDecision === 'REVIEW_REQUIRED' || item.reviewDecision === 'CHANGES_REQUESTED'
}

function canMergeImmediately(item: MobilePRAutoMergeAvailabilityInput): boolean {
  if (item.mergeStateStatus === 'BLOCKED' || item.mergeStateStatus === 'BEHIND') {
    return false
  }
  return item.mergeable === 'MERGEABLE' || item.mergeStateStatus === 'CLEAN'
}

function canRequestWhenReady(item: MobilePRAutoMergeAvailabilityInput): boolean {
  if (item.state !== 'open' || isConflicting(item)) {
    return false
  }
  if (item.mergeQueueRequired === true) {
    return true
  }
  return (
    item.autoMergeAllowed !== false && (hasReviewRequirement(item) || !canMergeImmediately(item))
  )
}

export function canShowMobilePRAutoMergeControl(item: MobilePRAutoMergeAvailabilityInput): boolean {
  // Why: Metro/Expo cannot reliably transform runtime imports from root
  // src/shared, so this mirrors github-pr-auto-merge-availability.ts.
  return item.state === 'open' && (item.autoMergeEnabled === true || canRequestWhenReady(item))
}
