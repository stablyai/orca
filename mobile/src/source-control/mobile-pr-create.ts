import { hostedReviewCopy } from './hosted-review-copy'
import {
  buildMobileHostedReviewCreateParams,
  createMobileHostedReview,
  fetchMobileHostedReviewEligibility,
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
  fetchMobileHostedReviewEligibility as fetchMobilePrEligibility,
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
      ? `${copy.titleLabel} #${outcome.number} is already open.`
      : `${copy.titleLabel} is already open.`
  }
  if (outcome.linkError) {
    return `${copy.titleLabel} created, but Orca could not refresh it yet.`
  }
  return undefined
}

export function getMobilePrCreateBlockMessage(prefill: MobilePrPrefill): string | null {
  const copy = hostedReviewCopy(prefill.provider)
  if (prefill.canCreate !== false || shouldPushBeforeMobileHostedReviewCreate(prefill)) {
    // Fail closed: only an accepted no-review lookup (`not_found`) may open
    // Create / Push & Create. `unavailable`, `found`, or a missing outcome (an
    // older host that predates the field) all leave review existence unproven —
    // mobile has no refresh/review-lookup signal of its own, so it must not
    // offer create, or the needs_push Push & Create path would slip through.
    if (prefill.reviewLookupOutcome !== 'not_found') {
      return `Orca could not confirm whether this branch already has a ${copy.reviewLabel}. Try again in a moment.`
    }
    return null
  }
  switch (prefill.blockedReason) {
    case 'dirty':
      return `Commit changes before creating a ${copy.reviewLabel}.`
    case 'detached_head':
      return `Check out a branch before creating a ${copy.reviewLabel}.`
    case 'default_branch':
      return `Switch to a feature branch before creating a ${copy.reviewLabel}.`
    case 'no_upstream':
      return `Publish commits before creating a ${copy.reviewLabel}.`
    case 'needs_sync':
      return `Sync this branch before creating a ${copy.reviewLabel}.`
    case 'auth_required':
      return `Authenticate before creating a ${copy.reviewLabel}.`
    case 'unsupported_provider':
      return `Creating ${copy.reviewLabel}s is not supported for this repo.`
    case 'existing_review':
      return `A ${copy.reviewLabel} already exists for this branch.`
    case 'fork_head_unsupported':
      return `Creating a ${copy.reviewLabel} from this fork is not supported.`
    case 'base_not_on_remote':
      return `Push the base branch before creating a ${copy.reviewLabel}.`
    case 'needs_push':
    case null:
    case undefined:
      return `This branch is not ready for a ${copy.reviewLabel} yet.`
    default:
      // Why: desktop can add blocked reasons before a long-lived mobile branch
      // catches up; remain safely blocked while preserving merge-ref typechecks.
      return `This branch is not ready for a ${copy.reviewLabel} yet.`
  }
}
