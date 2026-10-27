// Unreadable legacy cards remain on disk and must never appear as empty messages.

import type { UnreadAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { readAgentJournalMessageBody } from '../../../shared/agent-session-journal-body-admission'
import { readStoredRejectionFact } from './journal-dispatch-reducer'
import type { QueuedMessageRow } from './queued-message-table'
import { readAgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'

export const LEGACY_QUEUED_MESSAGE_COLUMNS =
  'message_id, position, body_json, fingerprint, state, hold_reason, returned_reason, returned_rejection, consumed_as, queued_epoch, queued_sequence, options_json'

export function readStoredQueuedMessageRow(row: unknown): QueuedMessageRow | null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: rows come from the legacy SELECTs (`LEGACY_QUEUED_MESSAGE_COLUMNS`), which name exactly these columns; better-sqlite3 types them as unknown.
  const record = row as {
    message_id: string
    position: number
    body_json: string
    fingerprint: string
    state: string
    hold_reason: string | null
    returned_reason: string | null
    returned_rejection: string | null
    consumed_as: string | null
    queued_epoch: string | null
    queued_sequence: number | null
    options_json: string | null
  }
  let body: AgentJournalMessageItem
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: checked by readAgentJournalMessageBody just below before any use.
    body = JSON.parse(record.body_json) as AgentJournalMessageItem
  } catch {
    return null
  }
  const state = record.state
  if (
    readAgentJournalMessageBody(body) !== 'readable' ||
    (state !== 'waiting' && state !== 'dispatched' && state !== 'returned' && state !== 'withdrawn')
  ) {
    return null
  }
  return {
    messageId: record.message_id,
    position: record.position,
    body,
    fingerprint: record.fingerprint,
    state,
    holdReason: storedHoldReason(record.hold_reason),
    returnedReason: record.returned_reason,
    returnedRejection: storedRejection(record.returned_rejection),
    consumedAs: record.consumed_as,
    queuedAt:
      record.queued_epoch !== null && typeof record.queued_sequence === 'number'
        ? { epoch: record.queued_epoch, sequence: record.queued_sequence }
        : null,
    ...storedOptions(record.options_json)
  }
}

/** Invalid execution options must not discard the card. */
function storedOptions(json: string | null): Pick<QueuedMessageRow, 'options'> {
  if (json === null) {
    return {}
  }
  try {
    const options = readAgentSessionExecutionOptions(JSON.parse(json))
    return options ? { options } : {}
  } catch {
    return {}
  }
}

/** Legacy per-card reasons now derive from queue pauses. */
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
    // Preserve readable refusal text when the typed fact is malformed.
    return null
  }
}
