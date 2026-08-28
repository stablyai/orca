// Persisted journal row shapes plus read-time upcasting.
//
// The journal is append-only, so migration is upcasting on read and never an
// in-place rewrite. A row whose version this build does not understand is
// UNREADABLE, not skippable: the caller must degrade to read-only rather than
// render a partial timeline or compact past a row it cannot interpret.

import {
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentJournalDispatchState,
  type AgentJournalItemBody,
  type AgentJournalMessageItem,
  type AgentSessionProviderHandle
} from '../../../shared/agent-session-journal-types'
import {
  isAgentJournalItemBody,
  isAgentSessionProviderHandle,
  isFiniteNumber,
  isNonEmptyString,
  isNonNegativeInteger
} from './journal-persisted-shapes'

export type JournalRowBase = {
  /** Schema version of THIS row. */
  v: number
  epoch: string
  seq: number
  /** Runtime fence held by the writer that appended the row. */
  fence: number
  /** Observed (provider or host) timestamp. Ordering is by `seq`, not by this. */
  ts: number
  /** Set when crash reconciliation appended the row after the fact. */
  recovered?: true
}

/** First row of every epoch: binds the epoch to a provider handle and records why it opened. */
export type JournalEpochRow = JournalRowBase & {
  kind: 'epoch'
  reason: AgentJournalEpochReason
  providerHandle: AgentSessionProviderHandle
}

export const AGENT_JOURNAL_EPOCH_REASONS = [
  'session_created',
  'legacy_import',
  'corruption',
  'unreconcilable_prefix',
  'handle_forked',
  'schema_unreadable'
] as const
export type AgentJournalEpochReason = (typeof AGENT_JOURNAL_EPOCH_REASONS)[number]

export type JournalItemRow = JournalRowBase & {
  kind: 'item'
  itemId: string
  revision: number
  body: AgentJournalItemBody
}

export type JournalTombstoneRow = JournalRowBase & {
  kind: 'tombstone'
  itemId: string
  revision: number
}

/** The write-ahead row. Durable BEFORE the adapter dispatches anything; it
 *  doubles as the optimistic user bubble so an accepted echo has a slot to
 *  reconcile into instead of appending a second copy. */
export type JournalSubmissionRow = JournalRowBase & {
  kind: 'submission'
  clientMessageId: string
  payloadFingerprint: string
  providerHandle: AgentSessionProviderHandle
  body: AgentJournalMessageItem
}

export type JournalDispatchRow = JournalRowBase & {
  kind: 'dispatch'
  clientMessageId: string
  state: Exclude<AgentJournalDispatchState, 'pending'>
  /** Provider item identity adopted on accept. */
  providerItemId: string | null
  reason: string | null
}

export type JournalRow =
  | JournalEpochRow
  | JournalItemRow
  | JournalTombstoneRow
  | JournalSubmissionRow
  | JournalDispatchRow

export type JournalRowPosition = { epoch: string; sequence: number }

export type JournalRowParse =
  | { ok: true; row: JournalRow }
  /** Malformed JSON or a shape this build rejects outright. */
  | { ok: false; unreadable: false; position?: JournalRowPosition }
  /** A future schema version. The host must not write or compact this journal. */
  | { ok: false; unreadable: true }

const ROW_KINDS = new Set(['epoch', 'item', 'tombstone', 'submission', 'dispatch'])
const EPOCH_REASONS = new Set(AGENT_JOURNAL_EPOCH_REASONS)
const DISPATCH_STATES = new Set(['accepted', 'rejected', 'unknown'])

export function journalRowBase(
  epoch: string,
  seq: number,
  fence: number,
  ts: number
): JournalRowBase {
  return { v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION, epoch, seq, fence, ts }
}

export function serializeJournalRow(row: JournalRow): string {
  return JSON.stringify(row)
}

/**
 * Parse one persisted line. Older versions are upcast; newer versions are
 * reported as unreadable so the caller fails closed.
 */
export function parseJournalRow(line: string): JournalRowParse {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { ok: false, unreadable: false }
  }
  return parseJournalRowValue(parsed)
}

export function parseJournalRowValue(parsed: unknown): JournalRowParse {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, unreadable: false }
  }
  const record = parsed as Record<string, unknown>
  const position = journalRowPosition(record)
  const version = typeof record.v === 'number' ? record.v : null
  if (version === null || !Number.isInteger(version) || version < 1) {
    return malformedRow(position)
  }
  if (version > AGENT_SESSION_JOURNAL_SCHEMA_VERSION) {
    return { ok: false, unreadable: true }
  }
  const upcast = upcastRow(record, version)
  return isJournalRow(upcast) ? { ok: true, row: upcast } : malformedRow(position)
}

function journalRowPosition(record: Record<string, unknown>): JournalRowPosition | null {
  return isNonEmptyString(record.epoch) &&
    Number.isInteger(record.seq) &&
    (record.seq as number) >= 1
    ? { epoch: record.epoch, sequence: record.seq as number }
    : null
}

function malformedRow(position: JournalRowPosition | null): JournalRowParse {
  return position ? { ok: false, unreadable: false, position } : { ok: false, unreadable: false }
}

/** Read-time upcast chain. Each step raises a row exactly one version. */
function upcastRow(record: Record<string, unknown>, version: number): Record<string, unknown> {
  let current = record
  let at = version
  while (at < AGENT_SESSION_JOURNAL_SCHEMA_VERSION) {
    // No upcasters yet — v1 is the first shipped schema. New cases go here.
    current = { ...current, v: at + 1 }
    at += 1
  }
  return current
}

function isJournalRow(record: Record<string, unknown>): record is JournalRow {
  if (typeof record.kind !== 'string' || !ROW_KINDS.has(record.kind)) {
    return false
  }
  if (
    !isNonEmptyString(record.epoch) ||
    !Number.isInteger(record.seq) ||
    (record.seq as number) < 1 ||
    !isNonNegativeInteger(record.fence) ||
    !isFiniteNumber(record.ts) ||
    (record.recovered !== undefined && record.recovered !== true)
  ) {
    return false
  }
  if (record.kind === 'epoch') {
    return (
      typeof record.reason === 'string' &&
      EPOCH_REASONS.has(record.reason as AgentJournalEpochReason) &&
      isAgentSessionProviderHandle(record.providerHandle)
    )
  }
  if (record.kind === 'item') {
    return (
      isNonEmptyString(record.itemId) &&
      isNonNegativeInteger(record.revision) &&
      isAgentJournalItemBody(record.body)
    )
  }
  if (record.kind === 'tombstone') {
    return isNonEmptyString(record.itemId) && isNonNegativeInteger(record.revision)
  }
  if (record.kind === 'submission') {
    return (
      isNonEmptyString(record.clientMessageId) &&
      typeof record.payloadFingerprint === 'string' &&
      isAgentSessionProviderHandle(record.providerHandle) &&
      isAgentJournalItemBody(record.body) &&
      record.body.kind === 'message'
    )
  }
  if (
    !isNonEmptyString(record.clientMessageId) ||
    typeof record.state !== 'string' ||
    !DISPATCH_STATES.has(record.state) ||
    !(record.reason === null || typeof record.reason === 'string')
  ) {
    return false
  }
  return record.state === 'accepted'
    ? isNonEmptyString(record.providerItemId) && record.reason === null
    : record.providerItemId === null
}

/** Approximate on-disk cost of a row, used for the per-session size bound. */
export function journalRowByteLength(row: JournalRow): number {
  return Buffer.byteLength(serializeJournalRow(row), 'utf8') + 1
}
