// Reads a `queued_messages` row back (`queued-message-table.ts`): a row this build cannot
// re-materialize is dropped, never shown as an empty message.

import type { UnreadAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { readStoredRejectionFact } from './journal-dispatch-reducer'
import type { QueuedMessageRow } from './queued-message-table'

/** A `queued_messages` row as this file's SELECTs return it; null when it cannot be read back. */
export function readStoredQueuedMessageRow(row: unknown): QueuedMessageRow | null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: rows come from this file's own SELECTs, which name exactly these columns; better-sqlite3 types them as unknown.
  const record = row as {
    session_id: string
    message_id: string
    position: number
    body_json: string
    fingerprint: string
    created_at: number
    host_instance: string
    state: string
    hold_reason: string | null
    returned_reason: string | null
    returned_rejection: string | null
    settled_at: number | null
    settled_by_op: string | null
    consumed_as: string | null
    carried_from: string | null
    queued_epoch: string | null
    queued_sequence: number | null
  }
  let body: AgentJournalMessageItem
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: body_json is written only by insertQueuedMessage from a schema-validated AgentJournalMessageItem.
    body = JSON.parse(record.body_json) as AgentJournalMessageItem
  } catch {
    // Our own writer stringified it; an unreadable body is corruption, and a
    // row we cannot re-materialize must not masquerade as an empty message.
    return null
  }
  const state = record.state
  if (
    state !== 'waiting' &&
    state !== 'dispatched' &&
    state !== 'returned' &&
    state !== 'withdrawn'
  ) {
    return null
  }
  return {
    sessionId: record.session_id,
    messageId: record.message_id,
    position: record.position,
    body,
    fingerprint: record.fingerprint,
    createdAt: record.created_at,
    hostInstance: record.host_instance,
    state,
    holdReason: storedHoldReason(record.hold_reason),
    returnedReason: record.returned_reason,
    returnedRejection: storedRejection(record.returned_rejection),
    settledAt: record.settled_at,
    settledByOp: record.settled_by_op,
    consumedAs: record.consumed_as,
    carriedFrom: record.carried_from,
    queuedAt:
      record.queued_epoch !== null && typeof record.queued_sequence === 'number'
        ? { epoch: record.queued_epoch, sequence: record.queued_sequence }
        : null
  }
}

/** Holds an earlier build stored that this one derives instead: a kept send (`kept`) waits under
 *  the reopen's pause, a Stop's (`stopped`) under the Stop's. */
const QUEUED_MESSAGE_RETIRED_HOLD_REASONS: ReadonlySet<string> = new Set(['kept', 'stopped'])

function storedHoldReason(stored: string | null): string | null {
  return stored !== null && QUEUED_MESSAGE_RETIRED_HOLD_REASONS.has(stored) ? null : stored
}

function storedRejection(json: string | null): UnreadAgentSessionFailureFact | null {
  if (json === null) {
    return null
  }
  try {
    return readStoredRejectionFact(JSON.parse(json)) ?? null
  } catch {
    // The refusal stays readable from `returned_reason`; a bad fact must not lose the card.
    return null
  }
}
