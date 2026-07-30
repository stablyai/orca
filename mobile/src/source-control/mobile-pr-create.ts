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
import { t } from '@/i18n/mobile-i18n'

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
      ? t('m.89Qhlf4', { value0: copy.titleLabel, value1: outcome.number })
      : t('m.ACQh2cM', { value0: copy.titleLabel })
  }
  if (outcome.linkError) {
    return t('m.nUw7_cE', { value0: copy.titleLabel })
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
      return t('m.YnkDu_A', { value0: copy.reviewLabel })
    }
    return null
  }
  switch (prefill.blockedReason) {
    case 'dirty':
      return t('m.fS2uz3k', { value0: copy.reviewLabel })
    case 'detached_head':
      return t('m.eL3YqZQ', { value0: copy.reviewLabel })
    case 'default_branch':
      return t('m.J6J02jo', { value0: copy.reviewLabel })
    case 'no_upstream':
      return t('m.aDj0ISs', { value0: copy.reviewLabel })
    case 'needs_sync':
      return t('m.h5c6qGM', { value0: copy.reviewLabel })
    case 'auth_required':
      return t('m.i65iwXo', { value0: copy.reviewLabel })
    case 'unsupported_provider':
      return t('m.CMzOREY', { value0: copy.reviewLabel })
    case 'existing_review':
      return t('m.UNrSqqU', { value0: copy.reviewLabel })
    case 'fork_head_unsupported':
      return t('m.dhReg-4', { value0: copy.reviewLabel })
    case 'base_not_on_remote':
      return t('m.eeoaUzE', { value0: copy.reviewLabel })
    case 'needs_push':
    case null:
    case undefined:
      return t('m.Kdbzhtg', { value0: copy.reviewLabel })
    default:
      // Why: desktop can add blocked reasons before a long-lived mobile branch
      // catches up; remain safely blocked while preserving merge-ref typechecks.
      return t('m.Kdbzhtg', { value0: copy.reviewLabel })
  }
}
