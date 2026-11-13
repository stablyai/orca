import type { CommunityDetail } from '../../shared/community-operations'
import type { CommunityEvidenceSignals } from '../../shared/community-features'
export function communityEvidenceSignals(
  headSha: string,
  evidence: Pick<
    CommunityDetail,
    | 'checks'
    | 'checksObserved'
    | 'checksComplete'
    | 'reviews'
    | 'reviewsObserved'
    | 'reviewsComplete'
  >,
  at: string
): CommunityEvidenceSignals {
  const reviews = new Map<string, string>()
  for (const row of evidence.reviews) {
    if (row.commit === headSha) {
      reviews.set(row.author, row.state)
    }
  }
  const review = [...reviews.values()].includes('CHANGES_REQUESTED')
    ? 'changes-requested'
    : [...reviews.values()].includes('APPROVED')
      ? 'approved'
      : evidence.reviewsObserved && evidence.reviewsComplete
        ? 'none'
        : 'unknown'
  const states = evidence.checks.map((check) => check.state.toLowerCase())
  const failed = states.some((state) =>
    ['failure', 'error', 'timed_out', 'cancelled', 'action_required', 'stale'].includes(state)
  )
  const pending = states.some((state) =>
    ['queued', 'pending', 'in_progress', 'requested', 'waiting'].includes(state)
  )
  const allPassed = states.every((state) => ['success', 'neutral', 'skipped'].includes(state))
  const checks = failed
    ? 'attention'
    : pending
      ? 'pending'
      : !evidence.checksObserved || !evidence.checksComplete
        ? 'unknown'
        : !states.length
          ? 'none'
          : allPassed
            ? 'passed'
            : 'unknown'
  return { headSha, capturedAt: at, review, checks }
}
