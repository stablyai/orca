// Crash recovery resolves durable submissions against history without automatic redelivery.
// Match echoed IDs, adopted keys, then unique fingerprints; identical sends must never collapse.

import type {
  AgentJournalItemIdentity,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { DISPATCH_REJECTED_NOT_DELIVERED } from '../../../shared/structured-agent-session-dispatch-rejection'

export type ProviderHistoryItem = {
  /** Claim each provider item once; derive journal keys from identity instead of unstable raw IDs. */
  providerItemId: string
  /** Null when the provider does not echo client IDs. */
  clientMessageId: string | null
  /** Match only a unique unclaimed payload candidate. */
  payloadFingerprint: string | null
  /** Absent identity preserves the submission's existing Orca key. */
  identity?: AgentJournalItemIdentity
}

export type ProviderHistoryWindow = {
  items: readonly ProviderHistoryItem[]
  /** Only a complete, consistent history boundary can prove non-delivery by absence. */
  boundaryConsistent: boolean
  /** An in-flight turn makes absence inconclusive. */
  turnInFlight: boolean
}

export type SubmissionReconciliation =
  | {
      clientMessageId: string
      outcome: 'accepted'
      providerItemId: string
      identity: AgentJournalItemIdentity
    }
  | { clientMessageId: string; outcome: 'rejected'; reason: SubmissionRejectionReason }
  | { clientMessageId: string; outcome: 'unknown'; reason: SubmissionUnknownReason }

export type SubmissionRejectionReason = typeof DISPATCH_REJECTED_NOT_DELIVERED

export type SubmissionUnknownReason =
  | 'history_boundary_inconsistent'
  | 'turn_in_flight'
  | 'ambiguous_match'

/** Run stronger matches across all submissions first; weak matches cannot steal exact-ID candidates. */
export function reconcileSubmissions(input: {
  submissions: readonly AgentJournalSubmission[]
  history: ProviderHistoryWindow
}): SubmissionReconciliation[] {
  const unsettled = input.submissions.filter(
    (submission) => submission.dispatchState === 'pending' || submission.dispatchState === 'unknown'
  )
  const claimed = new Set<string>()
  const matched = new Map<string, ProviderHistoryItem>()
  const ambiguous = new Set<string>()

  claimBy(
    unsettled,
    input.history.items,
    claimed,
    matched,
    (submission, item) =>
      // Adopted keys survive provider raw-ID renumbering.
      Boolean(submission.providerItemId) &&
      item.identity !== undefined &&
      submission.providerItemId === agentJournalItemKey(item.identity)
  )
  claimBy(
    unsettled,
    input.history.items,
    claimed,
    matched,
    (submission, item) =>
      Boolean(item.clientMessageId) && item.clientMessageId === submission.clientMessageId
  )

  // Match fingerprint groups together: one candidate cannot distinguish identical submissions.
  const submissionsByFingerprint = new Map<string, AgentJournalSubmission[]>()
  for (const submission of unsettled) {
    if (matched.has(submission.clientMessageId) || !submission.payloadFingerprint) {
      continue
    }
    const sameFingerprint = submissionsByFingerprint.get(submission.payloadFingerprint) ?? []
    sameFingerprint.push(submission)
    submissionsByFingerprint.set(submission.payloadFingerprint, sameFingerprint)
  }
  for (const [fingerprint, fingerprintSubmissions] of submissionsByFingerprint) {
    const candidates = input.history.items.filter(
      (item) => !claimed.has(item.providerItemId) && item.payloadFingerprint === fingerprint
    )
    if (fingerprintSubmissions.length === 1 && candidates.length === 1) {
      const [submission] = fingerprintSubmissions
      const [only] = candidates
      claimed.add(only!.providerItemId)
      matched.set(submission!.clientMessageId, only!)
      continue
    }
    if (candidates.length > 0) {
      // Equal payloads without IDs cannot establish which submission arrived.
      for (const submission of fingerprintSubmissions) {
        ambiguous.add(submission.clientMessageId)
      }
    }
  }

  return unsettled.map((submission) => resolveOne(submission, matched, ambiguous, input.history))
}

function claimBy(
  submissions: readonly AgentJournalSubmission[],
  items: readonly ProviderHistoryItem[],
  claimed: Set<string>,
  matched: Map<string, ProviderHistoryItem>,
  matches: (submission: AgentJournalSubmission, item: ProviderHistoryItem) => boolean
): void {
  for (const submission of submissions) {
    if (matched.has(submission.clientMessageId)) {
      continue
    }
    const item = items.find((candidate) => {
      return !claimed.has(candidate.providerItemId) && matches(submission, candidate)
    })
    if (item) {
      claimed.add(item.providerItemId)
      matched.set(submission.clientMessageId, item)
    }
  }
}

function resolveOne(
  submission: AgentJournalSubmission,
  matched: Map<string, ProviderHistoryItem>,
  ambiguous: Set<string>,
  history: ProviderHistoryWindow
): SubmissionReconciliation {
  const item = matched.get(submission.clientMessageId)
  if (item) {
    return {
      clientMessageId: submission.clientMessageId,
      outcome: 'accepted',
      providerItemId: item.providerItemId,
      identity: item.identity ?? { provider: 'orca', clientMessageId: submission.clientMessageId }
    }
  }
  if (ambiguous.has(submission.clientMessageId)) {
    return {
      clientMessageId: submission.clientMessageId,
      outcome: 'unknown',
      reason: 'ambiguous_match'
    }
  }
  if (!history.boundaryConsistent) {
    return {
      clientMessageId: submission.clientMessageId,
      outcome: 'unknown',
      reason: 'history_boundary_inconsistent'
    }
  }
  if (history.turnInFlight) {
    return {
      clientMessageId: submission.clientMessageId,
      outcome: 'unknown',
      reason: 'turn_in_flight'
    }
  }
  return {
    clientMessageId: submission.clientMessageId,
    outcome: 'rejected',
    reason: DISPATCH_REJECTED_NOT_DELIVERED
  }
}
