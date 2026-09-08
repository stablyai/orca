import type {
  CreateHostedReviewResult,
  HostedReviewCreationEligibility,
  HostedReviewSummary
} from '../../../../shared/hosted-review'

/** The host's eligibility and create answers carry free text a provider wrote; the page contract
 *  caps each field, so they are clipped to it rather than failing the whole call. */
export function clipMobileWebReviewEligibility(eligibility: HostedReviewCreationEligibility) {
  return {
    provider: eligibility.provider,
    review: clipReviewSummary(eligibility.review),
    canCreate: eligibility.canCreate,
    blockedReason: eligibility.blockedReason,
    nextAction: eligibility.nextAction,
    reviewLookupOutcome: eligibility.reviewLookupOutcome,
    ...(eligibility.defaultBaseRef === undefined
      ? {}
      : { defaultBaseRef: eligibility.defaultBaseRef?.slice(0, 512) ?? null }),
    ...(eligibility.head === undefined ? {} : { head: eligibility.head?.slice(0, 512) ?? null }),
    ...(eligibility.title === undefined ? {} : { title: eligibility.title?.slice(0, 512) ?? null }),
    ...(eligibility.body === undefined
      ? {}
      : { body: eligibility.body?.slice(0, 32 * 1024) ?? null })
  }
}

export function clipMobileWebReviewCreateResult(result: CreateHostedReviewResult) {
  if (result.ok) {
    return { ok: true as const, number: result.number, url: result.url }
  }
  return {
    ok: false as const,
    code: result.code,
    error: result.error.slice(0, 1024),
    ...(result.existingReview ? { existingReview: reviewSummary(result.existingReview) } : {})
  }
}

function clipReviewSummary(summary: HostedReviewSummary | null) {
  return summary === null ? null : reviewSummary(summary)
}

function reviewSummary(summary: HostedReviewSummary) {
  return { ...(summary.number === undefined ? {} : { number: summary.number }), url: summary.url }
}
