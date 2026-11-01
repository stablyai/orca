import { translate } from '../i18n/mobile-i18n'
import { isHostedReviewCreateEligibilityConfirmable } from '../../../src/shared/hosted-review-create-confirmation'
import { hostedReviewCopy } from './hosted-review-copy'
import {
  buildMobileHostedReviewCreateParams,
  createMobileHostedReview,
  mobileRepoSelectorFromWorktreeId,
  resolveMobileHostedReviewPrefill,
  shouldPushBeforeMobileHostedReviewCreate,
  type MobileHostedReviewCreateInput,
  type MobileHostedReviewCreateOutcome,
  type MobileHostedReviewEligibilityInput,
  type MobileHostedReviewPrefill
} from './mobile-hosted-review-service'

export type MobilePrEligibilityInput = MobileHostedReviewEligibilityInput
export type MobilePrPrefill = MobileHostedReviewPrefill
export type MobilePrCreateInput = MobileHostedReviewCreateInput
export type MobilePrCreateOutcome = MobileHostedReviewCreateOutcome

export {
  buildMobileHostedReviewCreateParams as buildMobilePrCreateParams,
  createMobileHostedReview as createMobilePr,
  mobileRepoSelectorFromWorktreeId,
  resolveMobileHostedReviewPrefill as resolveMobilePrPrefill,
  shouldPushBeforeMobileHostedReviewCreate as shouldPushBeforeMobilePrCreate
}

export function getMobilePrCreateSuccessWarning(
  outcome: Extract<MobilePrCreateOutcome, { ok: true }>,
  provider: MobilePrPrefill['provider']
): string | undefined {
  const copy = hostedReviewCopy(provider)
  if (outcome.existing) {
    return outcome.number
      ? translate(
          'sourceControl.prCreate.existingNumber',
          '{{titleLabel}} #{{number}} is already open.',
          { titleLabel: copy.titleLabel, number: outcome.number }
        )
      : translate('sourceControl.prCreate.existing', '{{titleLabel}} is already open.', {
          titleLabel: copy.titleLabel
        })
  }
  if (outcome.linkError) {
    return translate(
      'sourceControl.prCreate.createdNotRefreshed',
      '{{titleLabel}} created, but Orca could not refresh it yet.',
      { titleLabel: copy.titleLabel }
    )
  }
  return undefined
}

export function getMobilePrCreateBlockMessage(prefill: MobilePrPrefill): string | null {
  const copy = hostedReviewCopy(prefill.provider)
  // Hosts older than reviewLookupOutcome cannot prove no review exists, and mobile has no lookup of its own.
  const reviewLookupKnown = prefill.reviewLookupOutcome !== undefined
  if (
    reviewLookupKnown &&
    isHostedReviewCreateEligibilityConfirmable({
      eligibility: prefill,
      reviewLookup: 'unknown',
      hasHardRefreshError: false
    })
  ) {
    return null
  }
  if (
    prefill.reviewLookupOutcome === 'unavailable' ||
    (!reviewLookupKnown && (prefill.canCreate === true || prefill.blockedReason === 'needs_push'))
  ) {
    return translate(
      'sourceControl.prCreate.lookupUnconfirmed',
      'Orca could not confirm whether this branch already has a {{reviewLabel}}. Try again in a moment.',
      { reviewLabel: copy.reviewLabel }
    )
  }
  switch (prefill.blockedReason) {
    case 'dirty':
      return translate(
        'sourceControl.prCreate.dirty',
        'Commit changes before creating a {{reviewLabel}}.',
        { reviewLabel: copy.reviewLabel }
      )
    case 'detached_head':
      return translate(
        'sourceControl.prCreate.detachedHead',
        'Check out a branch before creating a {{reviewLabel}}.',
        { reviewLabel: copy.reviewLabel }
      )
    case 'default_branch':
      return translate(
        'sourceControl.prCreate.defaultBranch',
        'Switch to a feature branch before creating a {{reviewLabel}}.',
        { reviewLabel: copy.reviewLabel }
      )
    case 'no_upstream':
      return translate(
        'sourceControl.prCreate.noUpstream',
        'Publish commits before creating a {{reviewLabel}}.',
        { reviewLabel: copy.reviewLabel }
      )
    case 'needs_sync':
      return translate(
        'sourceControl.prCreate.needsSync',
        'Sync this branch before creating a {{reviewLabel}}.',
        { reviewLabel: copy.reviewLabel }
      )
    case 'auth_required':
      return translate(
        'sourceControl.prCreate.authRequired',
        'Authenticate before creating a {{reviewLabel}}.',
        { reviewLabel: copy.reviewLabel }
      )
    case 'unsupported_provider':
      return prefill.provider === 'gitlab'
        ? translate(
            'sourceControl.prCreate.unsupportedMergeRequests',
            'Creating merge requests is not supported for this repo.'
          )
        : translate(
            'sourceControl.prCreate.unsupportedPullRequests',
            'Creating pull requests is not supported for this repo.'
          )
    case 'existing_review':
      return translate(
        'sourceControl.prCreate.existingReview',
        'A {{reviewLabel}} already exists for this branch.',
        { reviewLabel: copy.reviewLabel }
      )
    case 'fork_head_unsupported':
      return translate(
        'sourceControl.prCreate.forkHeadUnsupported',
        'Creating a {{reviewLabel}} from this fork is not supported.',
        { reviewLabel: copy.reviewLabel }
      )
    case 'base_not_on_remote':
      return translate(
        'sourceControl.prCreate.baseNotOnRemote',
        'Push the base branch before creating a {{reviewLabel}}.',
        { reviewLabel: copy.reviewLabel }
      )
    case 'needs_push':
    case null:
    case undefined:
      return translate(
        'sourceControl.prCreate.notReady',
        'This branch is not ready for a {{reviewLabel}} yet.',
        { reviewLabel: copy.reviewLabel }
      )
    default:
      // Accept future desktop blocked reasons while remaining safely blocked.
      return translate(
        'sourceControl.prCreate.notReady',
        'This branch is not ready for a {{reviewLabel}} yet.',
        { reviewLabel: copy.reviewLabel }
      )
  }
}
