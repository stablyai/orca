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
  type AgentJournalProducerLinkage,
  type AgentSessionProviderHandle
} from '../../../shared/agent-session-journal-types'
import {
  isAdmissibleAgentJournalItemBody,
  isAdmissibleAgentJournalMessageBody
} from '../../../shared/agent-session-journal-schemas'
import { isAdmissibleAgentSessionContextUsage } from '../../../shared/agent-session-context-usage-schema'

/** Producer linkage rides the row BASE rather than the body: the two nested
 *  prompt shapes are `.strict()`, so an unknown key on a body would make the
 *  whole row parse as malformed. It is also deliberately not a `v` bump — an
 *  unknown `v` makes a row unreadable and latches the host read-only, while an
 *  unknown KEY is ignored below, so an older host reads a stamped row and
 *  behaves exactly as it does today. */
type JournalRowBase = AgentJournalProducerLinkage & {
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
  state: AgentJournalDispatchState
  /** Provider item identity adopted on accept. */
  providerItemId: string | null
  reason: string | null
}

/** An item mutation may name its own producer, because one batch can CREATE
 *  rows several agents produced. Naming none keeps the row's existing producer.
 *  Inline like the row base, and for the same reason no `v` bump: an older host
 *  ignores the unknown keys and reads the mutation as root, as it always did. */
export type JournalLifecycleMutation =
  | (AgentJournalProducerLinkage & {
      kind: 'item'
      itemId: string
      revision: number
      body: AgentJournalItemBody
    })
  | { kind: 'tombstone'; itemId: string; revision: number }

/** One durable append whose nested mutations share the outer ordering facts. */
export type JournalLifecycleBatchRow = JournalRowBase & {
  kind: 'lifecycle-batch'
  settlementId: string
  mutations: JournalLifecycleMutation[]
}

export const MAX_JOURNAL_LIFECYCLE_BATCH_BYTES = 1_500_000
export const MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS = 200

export type JournalRow =
  | JournalEpochRow
  | JournalItemRow
  | JournalTombstoneRow
  | JournalSubmissionRow
  | JournalDispatchRow
  | JournalLifecycleBatchRow

export type JournalRowParse =
  | { ok: true; row: JournalRow }
  /** Malformed JSON or a shape this build rejects outright. */
  | { ok: false; unreadable: false }
  /** A future schema version. The host must not write or compact this journal. */
  | { ok: false; unreadable: true }

const ROW_KINDS = new Set([
  'epoch',
  'item',
  'tombstone',
  'submission',
  'dispatch',
  'lifecycle-batch'
])

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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, unreadable: false }
  }
  const record = parsed as Record<string, unknown>
  const version = typeof record.v === 'number' ? record.v : null
  if (version === null || !Number.isInteger(version) || version < 1) {
    return { ok: false, unreadable: false }
  }
  if (version > AGENT_SESSION_JOURNAL_SCHEMA_VERSION) {
    return { ok: false, unreadable: true }
  }
  const upcast = upcastRow(record, version)
  dropUnusableProducerLinkage(upcast)
  if (upcast.kind === 'lifecycle-batch' && Array.isArray(upcast.mutations)) {
    for (const mutation of upcast.mutations) {
      if (isPlainObject(mutation)) {
        dropUnusableProducerLinkage(mutation)
      }
    }
  }
  dropUnusableContextUsage(upcast)
  return isJournalRow(upcast) ? { ok: true, row: upcast } : { ok: false, unreadable: false }
}

/** Linkage ids this build cannot trust, removed from a row it still keeps.
 *
 *  Deliberately NOT part of `isJournalRow`: rejecting a row there drops it from
 *  the timeline, so a validator tightened against one bad field becomes a
 *  whole-store kill switch. Dropping the field degrades the row to the
 *  session's own agent — what every row said before linkage existed — while
 *  keeping the content, which is always the safer direction. An `agentId` that
 *  survives is a real one: the reader scopes on PRESENCE, so `''` or a
 *  non-string left in place would hide the row from its own author for good. */
function dropUnusableProducerLinkage(record: Record<string, unknown>): void {
  for (const field of ['agentId', 'parentAgentId', 'providerParentRef', 'producerKind']) {
    const value = record[field]
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      delete record[field]
    }
  }
  if (record.attempt !== undefined && !Number.isInteger(record.attempt)) {
    delete record.attempt
  }
}

/** Context facts this build cannot read, removed from the turn row that carries
 *  them. Same reasoning as linkage: they are an annotation on the turn, and
 *  rejecting the row for them would truncate the journal from that row on. */
function dropUnusableContextUsage(record: Record<string, unknown>): void {
  const bodies = [
    record.kind === 'item' ? record.body : undefined,
    ...(record.kind === 'lifecycle-batch' && Array.isArray(record.mutations)
      ? record.mutations.map((mutation) => (isPlainObject(mutation) ? mutation.body : undefined))
      : [])
  ]
  for (const body of bodies) {
    if (
      isPlainObject(body) &&
      body.kind === 'turn' &&
      body.contextUsage !== undefined &&
      !isAdmissibleAgentSessionContextUsage(body.contextUsage)
    ) {
      delete body.contextUsage
    }
  }
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Open field values are type-checked, never enum-checked: a future build
 *  adding a dispatch state or handle kind must bump the row version, but this
 *  build should not misread a same-version row as malformed over a wider enum.
 *  Render BODIES are the exception and validate against the canonical deep
 *  schema — their nested shapes are dereferenced unguarded all the way to the
 *  rendered surface, so a JSON-valid corruption must fail here, not there. */
function isJournalRow(record: Record<string, unknown>): record is JournalRow {
  if (typeof record.kind !== 'string' || !ROW_KINDS.has(record.kind)) {
    return false
  }
  if (
    typeof record.epoch !== 'string' ||
    !record.epoch ||
    !Number.isInteger(record.seq) ||
    (record.seq as number) < 1 ||
    !Number.isInteger(record.fence) ||
    typeof record.ts !== 'number'
  ) {
    return false
  }
  if (record.kind === 'item') {
    return (
      typeof record.itemId === 'string' &&
      Number.isInteger(record.revision) &&
      isAdmissibleAgentJournalItemBody(record.body)
    )
  }
  if (record.kind === 'tombstone') {
    return typeof record.itemId === 'string' && Number.isInteger(record.revision)
  }
  if (record.kind === 'submission') {
    return (
      typeof record.clientMessageId === 'string' &&
      record.clientMessageId.length > 0 &&
      typeof record.payloadFingerprint === 'string' &&
      isPlainObject(record.providerHandle) &&
      isAdmissibleAgentJournalMessageBody(record.body)
    )
  }
  if (record.kind === 'dispatch') {
    return (
      typeof record.clientMessageId === 'string' &&
      record.clientMessageId.length > 0 &&
      typeof record.state === 'string' &&
      record.state.length > 0 &&
      (record.providerItemId === null || typeof record.providerItemId === 'string') &&
      (record.reason === null || typeof record.reason === 'string')
    )
  }
  if (record.kind === 'lifecycle-batch') {
    return (
      typeof record.settlementId === 'string' &&
      record.settlementId.length > 0 &&
      Array.isArray(record.mutations) &&
      record.mutations.length > 0 &&
      record.mutations.length <= MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS &&
      Buffer.byteLength(JSON.stringify(record), 'utf8') + 1 <= MAX_JOURNAL_LIFECYCLE_BATCH_BYTES &&
      record.mutations.every(isLifecycleMutation)
    )
  }
  return typeof record.reason === 'string' && isPlainObject(record.providerHandle)
}

function isLifecycleMutation(value: unknown): value is JournalLifecycleMutation {
  if (!isPlainObject(value) || typeof value.itemId !== 'string') {
    return false
  }
  if (value.kind === 'tombstone') {
    return Number.isInteger(value.revision)
  }
  return (
    value.kind === 'item' &&
    Number.isInteger(value.revision) &&
    isAdmissibleAgentJournalItemBody(value.body)
  )
}

/** Approximate on-disk cost of a row, used for the per-session size bound. */
export function journalRowByteLength(row: JournalRow): number {
  return Buffer.byteLength(serializeJournalRow(row), 'utf8') + 1
}
