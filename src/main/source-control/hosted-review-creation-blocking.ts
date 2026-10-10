import type {
  CreateHostedReviewResult,
  HostedReviewCreationBlockedReason,
  HostedReviewCreationEligibility,
  HostedReviewProvider
} from '../../shared/hosted-review'
import { reviewCopy } from './hosted-review-creation-provider'

function blockedCreateResultForReason(
  reason: NonNullable<HostedReviewCreationBlockedReason>,
  provider: HostedReviewProvider,
  submittedBase?: string | null
): CreateHostedReviewResult | null {
  const copy = reviewCopy(provider)
  const baseLabel = submittedBase?.trim() ? `"${submittedBase.trim()}" ` : ''
  const blockedCreateResultByReason = {
    auth_required: {
      ok: false,
      code: 'auth_required',
      error: `Create ${copy.shortLabel} failed: ${copy.providerName} is not authenticated. Next step: ${copy.authInstruction} in this environment.`
    },
    unsupported_provider: {
      ok: false,
      code: 'unsupported_provider',
      error: `Creating ${copy.reviewLabel}s requires a ${copy.providerName} remote.`
    },
    dirty: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: commit or discard local changes before creating a ${copy.reviewLabel}.`
    },
    detached_head: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: switch to a branch before creating a ${copy.reviewLabel}.`
    },
    default_branch: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: choose a feature branch before creating a ${copy.reviewLabel}.`
    },
    no_upstream: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: publish this branch before creating a ${copy.reviewLabel}.`
    },
    needs_push: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: push this branch before creating a ${copy.reviewLabel}.`
    },
    needs_sync: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: sync this branch before creating a ${copy.reviewLabel}.`
    },
    fork_head_unsupported: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: refresh source control status and try again.`
    },
    base_not_on_remote: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: the base branch ${baseLabel}hasn't been pushed to the remote. Choose a pushed base or push it first.`
    }
  } satisfies Partial<
    Record<NonNullable<HostedReviewCreationBlockedReason>, CreateHostedReviewResult>
  >
  return blockedCreateResultByReason[reason] ?? null
}

export function blockedEligibilityToCreateResult(
  eligibility: HostedReviewCreationEligibility,
  submittedBase?: string | null
): CreateHostedReviewResult | null {
  if (eligibility.canCreate) {
    return null
  }
  if (eligibility.review?.url) {
    const copy = reviewCopy(eligibility.provider)
    return {
      ok: false,
      code: 'already_exists',
      error: `A ${copy.reviewLabel} already exists for this branch.`,
      existingReview: eligibility.review
    }
  }
  if (eligibility.blockedReason) {
    return blockedCreateResultForReason(
      eligibility.blockedReason,
      eligibility.provider,
      submittedBase
    )
  }
  const copy = reviewCopy(eligibility.provider)
  return {
    ok: false,
    code: 'validation',
    error: `Create ${copy.shortLabel} failed: refresh source control status and try again.`
  }
}
