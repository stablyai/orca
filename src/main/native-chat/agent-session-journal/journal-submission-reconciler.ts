// Restart reconciliation for the crash boundary.
//
// A submission row is durable before dispatch, so after a crash the host knows
// what it TRIED to send but not whether the provider took it. Every surviving
// `pending` becomes `unknown` and is then matched against provider history.
//
// Matching is by identity only — an echoed client message id, else a provider
// item id the journal already adopted, else the payload fingerprint when it
// picks out exactly one unclaimed item. Never by text equality: the same
// question asked twice is two messages, and collapsing them silently loses one.
//
// Orca never re-sends on the user's behalf. An unresolved submission stays
// `unknown` — a displayed state meaning "delivery unconfirmed", neither sent nor
// failed — and the user chooses to resend or discard.

import type {
  AgentJournalItemIdentity,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { DISPATCH_REJECTED_NOT_DELIVERED } from '../../../shared/structured-agent-session-dispatch-rejection'

export type ProviderHistoryItem = {
  /** The provider's own id for this item. Used to claim it at most once; the
   *  journal key comes from `identity`, because a provider id is not stable. */
  providerItemId: string
  /** The client message id when the provider echoes one (Codex carries it on
   *  user messages); null for providers that drop it. */
  clientMessageId: string | null
  /** Fingerprint of the submitted payload, when the caller can compute one from
   *  provider content. Used only to break an otherwise unique tie. */
  payloadFingerprint: string | null
  /** Absent when the provider keeps no identity of its own for the item: a submission it matches
   *  keeps Orca's (`orca:<clientMessageId>`), which is the identity its row already has. */
  identity?: AgentJournalItemIdentity
}

export type ProviderHistoryWindow = {
  /** Provider items the read found: with a consistent boundary, all of them from the resume point on. */
  items: readonly ProviderHistoryItem[]
  /**
   * The history read actually started at the session's recorded resume point. A
   * fork, a compacted provider log, or a truncated read makes absence
   * meaningless, so a missing submission cannot be called "not delivered".
   */
  boundaryConsistent: boolean
  /** The provider reports a turn still running: absence proves nothing yet. */
  turnInFlight: boolean
}

/** When the resume point the read started at last moved: the fence its link was written at, and a
 *  host-clock stamp (the journal's clock) taken no earlier than the move itself. */
export type ProviderHistoryWindowStart = { fence: number; movedAt: number }

/** A window placed against the sends it is asked about. */
export type PlacedProviderHistoryWindow = ProviderHistoryWindow & {
  /** null when no recorded resume point bounds the read. */
  start: ProviderHistoryWindowStart | null
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
  | 'history_start_unproven'

/**
 * Resolve every unsettled submission against provider history.
 *
 * Passes run strongest-first across ALL submissions before the next begins, so
 * a weak fingerprint tie can never claim an item that an echoed client message
 * id would have matched exactly. Each history item is claimable once.
 */
export function reconcileSubmissions(input: {
  submissions: readonly AgentJournalSubmission[]
  history: PlacedProviderHistoryWindow
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
      // A submission that already adopted a key re-matches on that key, not on the
      // provider's raw id — the raw id renumbers, the identity-derived key does not.
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

  // Resolve fingerprint candidates as a batch. Assigning the sole candidate to
  // the first identical submission would make the later one look absent even
  // though either submission could be the delivered one.
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
      // Equal payloads without an id cannot be assigned safely, including when
      // fewer provider items exist than unsettled submissions.
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
  history: PlacedProviderHistoryWindow
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
  if (!windowStartsBeforeHandover(submission, history)) {
    return {
      clientMessageId: submission.clientMessageId,
      outcome: 'unknown',
      reason: 'history_start_unproven'
    }
  }
  // Absent from a history we can trust the boundary of, with nothing running:
  // the provider never took it.
  return {
    clientMessageId: submission.clientMessageId,
    outcome: 'rejected',
    reason: DISPATCH_REJECTED_NOT_DELIVERED
  }
}

/** Absence proves non-delivery only past where the read starts. Moves at an earlier fence precede
 *  any handover at a later one; at the same fence, the host clock orders them, ties unproven. */
function windowStartsBeforeHandover(
  submission: AgentJournalSubmission,
  history: PlacedProviderHistoryWindow
): boolean {
  const { start } = history
  const handover = submission.firstHandover
  if (!start || !handover) {
    return false
  }
  if (handover.fence !== start.fence) {
    return handover.fence > start.fence
  }
  return start.movedAt < handover.at
}
