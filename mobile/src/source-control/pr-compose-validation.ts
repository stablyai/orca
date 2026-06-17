import {
  normalizeHostedReviewBaseRef,
  normalizeHostedReviewHeadRef
} from '../../../src/shared/hosted-review-refs'

// Submit-gating for the create-PR composer, matching desktop CreatePullRequestDialog:
// the base ref must be non-empty and must differ from the head branch after ref
// normalization (strip refs/heads, remote prefixes, origin/upstream), case-insensitive.
// Reuses the shared normalizers so mobile and desktop compare refs identically.
export function isBaseHeadDistinct(base: string, head: string): boolean {
  const b = normalizeHostedReviewBaseRef(base).toLowerCase()
  const h = normalizeHostedReviewHeadRef(head).toLowerCase()
  return b.length > 0 && b !== h
}

export function canSubmitPrCompose(title: string, base: string, head: string): boolean {
  return title.trim().length > 0 && isBaseHeadDistinct(base, head)
}
