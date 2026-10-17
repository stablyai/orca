/**
 * The agent-session operation id one orchestration message's send to a chat runs under.
 *
 * Orchestration's own `msg_<hex>` ids do not match the host's `^\d{13}-[0-9a-f]{32}$` shape and are
 * refused before the first send, so the id is minted here instead. It is reused across retries,
 * because the id IS the send's idempotency key: a fresh id for the same message would land as a
 * second message, and the host replays a recorded id's verdict without reaching the provider, so a
 * retry after a failed send starts nothing. It is re-minted only when the send is owed again (see
 * `decideStructuredMailAttempt`). Age never re-mints a send the host recorded: its verdict is the
 * only evidence of whether the message landed.
 *
 * Nothing is stored for it. Each send names its message on the chat message itself
 * (`from.orchestration`), so the session's journal says which sends carried which message; this
 * process remembers only the ids it minted, which is what tells its own sends from an earlier
 * process's.
 */

import { randomBytes } from 'node:crypto'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS } from '../../../shared/agent-session-host-authority'

/** What the mail lane reads off a session's journal for its own sends. */
export type StructuredMailSubmission = Pick<
  AgentJournalSubmission,
  'clientMessageId' | 'dispatchState' | 'submittedAt'
> & {
  /** The orchestration message the send carried; absent for every other send. */
  mailMessageId?: string
}

/** An id this process minted for one message's send. */
export type StructuredMailOperation = { operationId: string; mintedAtMs: number }

export type StructuredMailSubmissionIndex = {
  byOperationId: ReadonlyMap<string, StructuredMailSubmission>
  byMessageId: ReadonlyMap<string, StructuredMailSubmission>
  latestSubmittedAt: number
  latestAcceptedAt: number
}

/** First operation match and last mail match, exactly as the journal's ordered lookups. */
export function indexStructuredMailSubmissions(
  submissions: readonly StructuredMailSubmission[]
): StructuredMailSubmissionIndex {
  const byOperationId = new Map<string, StructuredMailSubmission>()
  const byMessageId = new Map<string, StructuredMailSubmission>()
  let latestSubmittedAt = -Infinity
  let latestAcceptedAt = -Infinity
  for (const entry of submissions) {
    if (!byOperationId.has(entry.clientMessageId)) {
      byOperationId.set(entry.clientMessageId, entry)
    }
    if (entry.mailMessageId) {
      byMessageId.set(entry.mailMessageId, entry)
    }
    latestSubmittedAt = Math.max(latestSubmittedAt, entry.submittedAt)
    if (entry.dispatchState === 'accepted') {
      latestAcceptedAt = Math.max(latestAcceptedAt, entry.submittedAt)
    }
  }
  return { byOperationId, byMessageId, latestSubmittedAt, latestAcceptedAt }
}

/**
 * What to do with one message's send, given the id this process minted for it and the session's
 * recorded sends.
 *
 * - `stamp`: its send ran; the message is received.
 * - `park`: its send is still in flight; its settlement is the next edge.
 * - `mint`: a new send. Nothing was sent; the agent ran a turn after the last send; an earlier
 *   process sent it, so its attempt died with that process; or the host never recorded it and
 *   would now refuse it as too old to admit.
 * - `reuse`: resend under this process's id. Unrecorded, it is a first delivery; recorded as
 *   failed, the host replays that verdict and starts nothing, so a provider that dies on every turn
 *   is not restarted by every status edge, and a user's Stop stays stopped.
 */
export type StructuredMailAttempt = 'mint' | 'reuse' | 'stamp' | 'park'

export function decideStructuredMailAttempt(input: {
  messageId: string
  /** The session's recorded sends; a rewind may have dropped this process's. */
  submissions: readonly StructuredMailSubmission[]
  submissionIndex?: StructuredMailSubmissionIndex
  mintedByThisProcess: StructuredMailOperation | undefined
  now: number
}): StructuredMailAttempt {
  const { mintedByThisProcess } = input
  const index = input.submissionIndex ?? indexStructuredMailSubmissions(input.submissions)
  const recorded = index.byMessageId.get(input.messageId)
  if (recorded?.dispatchState === 'accepted') {
    return 'stamp'
  }
  const last =
    mintedByThisProcess ??
    (recorded && { operationId: recorded.clientMessageId, mintedAtMs: recorded.submittedAt })
  if (!last) {
    return 'mint'
  }
  const sent = index.byOperationId.get(last.operationId)
  if (sent?.dispatchState === 'accepted') {
    return 'stamp'
  }
  if (sent?.dispatchState === 'pending') {
    return 'park'
  }
  const ranSince = index.latestAcceptedAt > last.mintedAtMs
  const tooOldToAdmit =
    !sent && input.now - last.mintedAtMs > AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS
  return ranSince || !mintedByThisProcess || tooOldToAdmit ? 'mint' : 'reuse'
}

export function mintAgentSessionOperationId(now: number): string {
  return `${String(now).padStart(13, '0')}-${randomBytes(16).toString('hex')}`
}

export type StructuredMailOperationResolution =
  | { kind: 'send'; operation: StructuredMailOperation }
  | { kind: 'stamp' }
  | { kind: 'park' }

export function resolveStructuredMailOperation(args: {
  messageId: string
  submissions: readonly StructuredMailSubmission[]
  submissionIndex?: StructuredMailSubmissionIndex
  mintedByThisProcess: StructuredMailOperation | undefined
  now?: number
}): StructuredMailOperationResolution {
  const now = args.now ?? Date.now()
  const submissionIndex = args.submissionIndex ?? indexStructuredMailSubmissions(args.submissions)
  const attempt = decideStructuredMailAttempt({ ...args, submissionIndex, now })
  if (attempt === 'stamp' || attempt === 'park') {
    return { kind: attempt }
  }
  if (attempt === 'reuse' && args.mintedByThisProcess) {
    return { kind: 'send', operation: args.mintedByThisProcess }
  }
  return {
    kind: 'send',
    operation: {
      operationId: mintAgentSessionOperationId(now),
      // On the journal's clock too, so a backward clock step cannot date an earlier turn after it.
      mintedAtMs: Math.max(now, submissionIndex.latestSubmittedAt)
    }
  }
}
