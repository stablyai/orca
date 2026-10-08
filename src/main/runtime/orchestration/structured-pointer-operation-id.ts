/**
 * The agent-session operation id one structured worker mailbox's pointer send runs under.
 *
 * Orchestration's own `msg_<hex>` ids do not match the host's `^\d{13}-[0-9a-f]{32}$` shape and are
 * refused before the first send, so the id is minted here instead. It is durable and reused across
 * retries, because the id IS the send's idempotency key: a fresh id for the same nudge would land
 * as a second turn, and the host replays a recorded id's verdict without reaching the provider, so
 * a retry after a failed send starts nothing. It is re-minted only when the send is genuinely a
 * different call: a different batch of mail or session, or one the journal shows is owed again
 * (see `decideStructuredPointerAttempt`). Age never re-mints a send the host recorded: its verdict
 * is the only evidence of whether the nudge landed.
 *
 * Reuse is keyed on the MESSAGE IDS in the batch, never on the pointer body: the body names only
 * how many messages are waiting, so two unrelated same-size batches share a fingerprint. Reusing a
 * live id across them makes the host answer from its operation ledger — `accepted`, with no turn
 * sent — and this lane then marks the new mail delivered. That is silent mail loss.
 */

import { createHash, randomBytes } from 'node:crypto'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS } from '../../../shared/agent-session-host-authority'
import type { OrchestrationDb } from './db'
import type { StructuredPointerOperationRow } from './db/messages/structured-pointer-operation-store'

/** What the pointer lane reads off a session's journal for its own sends. */
export type StructuredPointerSubmission = Pick<
  AgentJournalSubmission,
  'clientMessageId' | 'dispatchState' | 'submittedAt'
>

/**
 * What to do with a mailbox's pointer, given its operation row and the session's recorded sends.
 *
 * - `stamp`: the row's send ran; the batch is pointed.
 * - `park`: the row's send is still in flight; its settlement is the next edge.
 * - `mint`: a new send. The batch or session changed; the agent ran a turn after the row was
 *   minted; an earlier process minted it, so its attempt died with that process; or the host never
 *   recorded it and would now refuse it as too old to admit.
 * - `reuse`: resend under the row's id. Unrecorded, it is a first delivery; recorded as failed, the
 *   host replays that verdict and starts nothing, so a provider that dies on every turn is not
 *   restarted by every status edge, and a user's Stop stays stopped.
 */
export type StructuredPointerAttempt = 'mint' | 'reuse' | 'stamp' | 'park'

export function decideStructuredPointerAttempt(input: {
  row: StructuredPointerOperationRow | undefined
  sessionId: string
  batchFingerprint: string
  /** The session's recorded sends; a rewind may have dropped the row's. */
  submissions: readonly StructuredPointerSubmission[]
  /** Whether this process minted the row's id. */
  mintedByThisProcess: boolean
  now: number
}): StructuredPointerAttempt {
  const { row, submissions } = input
  if (
    !row ||
    row.session_id !== input.sessionId ||
    row.batch_fingerprint !== input.batchFingerprint
  ) {
    return 'mint'
  }
  const sent = submissions.find((entry) => entry.clientMessageId === row.operation_id)
  if (sent?.dispatchState === 'accepted') {
    return 'stamp'
  }
  if (sent?.dispatchState === 'pending') {
    return 'park'
  }
  const ranSince = submissions.some(
    (entry) => entry.dispatchState === 'accepted' && entry.submittedAt > row.minted_at_ms
  )
  const tooOldToAdmit =
    !sent && input.now - row.minted_at_ms > AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS
  return ranSince || !input.mintedByThisProcess || tooOldToAdmit ? 'mint' : 'reuse'
}

export function mintAgentSessionOperationId(now: number): string {
  return `${String(now).padStart(13, '0')}-${randomBytes(16).toString('hex')}`
}

/** Batch identity, and the only thing reuse may be keyed on. */
export function structuredPointerBatchFingerprint(
  sessionId: string,
  messageIds: readonly string[]
): string {
  return createHash('sha256')
    .update(JSON.stringify([sessionId, messageIds]))
    .digest('base64url')
}

export type StructuredPointerOperation =
  | { kind: 'send'; operationId: string }
  | { kind: 'stamp' }
  | { kind: 'park' }

export function resolveStructuredPointerOperation(args: {
  db: OrchestrationDb
  mailboxHandle: string
  sessionId: string
  /** The rows this nudge stands for; batch identity, not the body, decides reuse. */
  messageIds: readonly string[]
  submissions: readonly StructuredPointerSubmission[]
  /** The operation id this process last sent for this mailbox, if any. */
  sentByThisProcess: string | undefined
  now?: number
}): StructuredPointerOperation {
  const now = args.now ?? Date.now()
  const batchFingerprint = structuredPointerBatchFingerprint(args.sessionId, args.messageIds)
  const stored = args.db.getStructuredPointerOperation(args.mailboxHandle)
  const attempt = decideStructuredPointerAttempt({
    row: stored,
    sessionId: args.sessionId,
    batchFingerprint,
    submissions: args.submissions,
    mintedByThisProcess: stored?.operation_id === args.sentByThisProcess,
    now
  })
  if (attempt === 'stamp' || attempt === 'park') {
    return { kind: attempt }
  }
  if (attempt === 'reuse' && stored) {
    return { kind: 'send', operationId: stored.operation_id }
  }
  const operationId = mintAgentSessionOperationId(now)
  args.db.putStructuredPointerOperation({
    mailbox_handle: args.mailboxHandle,
    session_id: args.sessionId,
    operation_id: operationId,
    batch_fingerprint: batchFingerprint,
    // On the journal's clock too, so a backward clock step cannot date an earlier turn after it.
    minted_at_ms: args.submissions.reduce(
      (latest, entry) => Math.max(latest, entry.submittedAt),
      now
    )
  })
  return { kind: 'send', operationId }
}
