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
      error: `Create ${copy.shortLabel} failed: ${copy.providerName} is not authenticated. Next step: ${copy.authInstruction} in this environment.`,
      reason: 'auth_required'
    },
    unsupported_provider: {
      ok: false,
      code: 'unsupported_provider',
      error: `Creating ${copy.reviewLabel}s requires a ${copy.providerName} remote.`,
      reason: 'unsupported_provider'
    },
    dirty: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: commit or discard local changes before creating a ${copy.reviewLabel}.`,
      reason: 'dirty'
    },
    detached_head: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: switch to a branch before creating a ${copy.reviewLabel}.`,
      reason: 'detached_head'
    },
    default_branch: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: choose a feature branch before creating a ${copy.reviewLabel}.`,
      reason: 'default_branch'
    },
    no_upstream: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: publish this branch before creating a ${copy.reviewLabel}.`,
      reason: 'no_upstream'
    },
    needs_push: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: push this branch before creating a ${copy.reviewLabel}.`,
      reason: 'needs_push'
    },
    needs_sync: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: sync this branch before creating a ${copy.reviewLabel}.`,
      reason: 'needs_sync'
    },
    fork_head_unsupported: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: refresh source control status and try again.`,
      reason: 'fork_head_unsupported'
    },
    base_not_on_remote: {
      ok: false,
      code: 'validation',
      error: `Create ${copy.shortLabel} failed: the base branch ${baseLabel}hasn't been pushed to the remote. Choose a pushed base or push it first.`,
      reason: 'base_not_on_remote',
      ...(submittedBase?.trim() ? { base: submittedBase.trim() } : {})
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
      reason: 'existing_review',
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
    error: `Create ${copy.shortLabel} failed: refresh source control status and try again.`,
    reason: 'branch_status_unverified'
  }
}
