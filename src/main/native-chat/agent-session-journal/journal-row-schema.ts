import type { JournalItemEcho } from './journal-item-echo'
import { journalTextRowContent, type JournalTextDeltaRow } from './journal-text-rows'
// Persisted journal row shapes plus read-time upcasting.
//
// The journal is append-only, so migration is upcasting on read and never an
// in-place rewrite. A row whose version this build does not understand is
// UNREADABLE, not skippable: the caller fails the load as a newer Orca's chat rather
// than render a partial timeline or compact past a row it cannot interpret.
//
// A row whose KIND this build does not know is UNREADABLE the same way, and kept
// on disk, when it has the envelope every row keeps: a non-empty `epoch`, an
// integer `seq` >= 1, an integer `fence` and a numeric `ts`. So a new kind keeps
// that envelope; changing the envelope is a `v` bump. Builds from before this
// rule delete the journal from an unknown kind, so a new kind either ships its
// reader first and is written only once no supported build lacks that reader,
// or is written at a bumped `v`.
//
// Inside a known row with that envelope the same holds a level down. A lifecycle mutation of a kind
// this build does not know, or a sent message of a kind it does not know, is UNREADABLE, whatever
// else in the row fails; unusable annotations are dropped. A body of a kind it does not know is
// READABLE and drawn by nobody (agent-session-journal-schemas.ts). Any other failure is damage, and
// the chat fails to load with every row kept (journal-open.ts). Builds from before this rule delete
// the journal from such a row, so the same reader-first-or-`v` rule applies to a new mutation or
// sent-message kind.

import type { AgentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import {
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentJournalDispatchState,
  type AgentJournalItemBody,
  type AgentJournalMessageItem,
  type AgentJournalProducerLinkage,
  type AgentJournalTurnScope,
  type AgentSessionJournalProviderHandle
} from '../../../shared/agent-session-journal-types'
import {
  readAgentJournalItemBody,
  readAgentJournalMessageBody,
  type AgentJournalContentVerdict
} from '../../../shared/agent-session-journal-body-admission'
import { isJournalTag } from '../../../shared/agent-session-journal-open-union'
import type { StructuredAgentSessionStopCause } from '../agent-session-wire/structured-agent-session-stop-cause'
import { dropUnusableRowAnnotations } from './journal-row-unusable-annotations'
import { journalQueueRowContent, type JournalQueueRow } from './journal-queue-events'

/** Put additive annotations on the base: older strict prompt bodies reject unknown keys. */
export type JournalRowBase = AgentJournalProducerLinkage & {
  v: number
  epoch: string
  seq: number
  fence: number
  /** Timestamp is observational; seq determines ordering. */
  ts: number
  recovered?: true
  /** Additive base field; absent legacy scopes are derived during replay. */
  turnScope?: AgentJournalTurnScope
}

export type JournalEpochRow = JournalRowBase & {
  kind: 'epoch'
  reason: AgentJournalEpochReason
  providerHandle: AgentSessionJournalProviderHandle
  /** Preserve original adoption through same-conversation epoch replacement. */
  historyOrigin?: unknown
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

/** Creation provenance differs from writer authority; legacy rows fall back to their creating fence. */
type JournalItemProvenance = {
  ownerFence?: number
  /** Later execution owner for resumable children; absent falls back to ownerFence. */
  executionOwner?: number
}

export type JournalItemRow = JournalRowBase &
  JournalItemProvenance &
  JournalItemEcho & {
    kind: 'item'
    itemId: string
    revision: number
    body: AgentJournalItemBody
  }

export type JournalTombstoneRow = JournalRowBase & {
  kind: 'tombstone'
  itemId: string
  revision: number
  /** Stop marker, not item removal; uses an unoccupied ID. */
  stopEvent?: JournalStopEvent
  /** Resume marker, not item removal; uses an unoccupied ID. */
  queueResume?: true
  /** Queue-reopen marker, not item removal; uses an unoccupied ID. */
  queueReopen?: true
  /** Earlier stop position lets subsequent acceptance lift the reopen mark; absent uses this row. */
  queueReopenSince?: number
  queueClear?: { operationId: string; messageIds: string[]; lifted?: true }
  retireSubmission?: true
}

/** Carry Stops as additive tombstone fields for readers that cannot safely handle unknown row kinds. */
export type JournalStopEvent = {
  /** Persisted reason names are stable; only user-stop pauses the queue. */
  reason: StructuredAgentSessionStopCause
  turnId?: string
  at: number
  caller?: string
}

export type JournalStopOrResumeRow = JournalTombstoneRow &
  (
    | { stopEvent: NonNullable<JournalTombstoneRow['stopEvent']> }
    | { queueResume: NonNullable<JournalTombstoneRow['queueResume']> }
    | { queueReopen: NonNullable<JournalTombstoneRow['queueReopen']> }
    | { queueClear: NonNullable<JournalTombstoneRow['queueClear']> }
  )

/** Any marker value suppresses removal, including values from newer builds. */
export function isJournalStopOrResumeRow(row: JournalRow): row is JournalStopOrResumeRow {
  return (
    row.kind === 'tombstone' &&
    (row.stopEvent !== undefined ||
      row.queueResume !== undefined ||
      row.queueReopen !== undefined ||
      row.queueClear !== undefined)
  )
}

/** Persist before dispatch; the optimistic bubble gives provider echoes a slot without duplication. */
export type JournalSubmissionRow = JournalRowBase & {
  kind: 'submission'
  clientMessageId: string
  payloadFingerprint: string
  providerHandle: AgentSessionJournalProviderHandle
  body: AgentJournalMessageItem
  /** Acceptance defers handover to dispatch/pending; absent legacy rows dispatched immediately. */
  handoverRecorded?: true
  queuedMessageId?: string
  /** client means explicit user send; host includes automatic queue drain and orchestration. */
  origin?: JournalSubmissionOrigin
  source?: { kind: string }
  /** Apply accepted execution choices at handover; ignore unknown legacy option keys. */
  options?: AgentSessionExecutionOptions
}

export type JournalSubmissionOrigin = 'client' | 'host'

export type JournalDispatchRow = JournalRowBase & {
  kind: 'dispatch'
  clientMessageId: string
  state: AgentJournalDispatchState
  providerItemId: string | null
  reason: string | null
  turnScope?: AgentJournalTurnScope
  /** Host-only ordered IDs of stopped messages carried into provider history on pending. */
  carries?: string[]
  /** Drop malformed typed rejection annotations without rejecting the row. */
  rejection?: AgentSessionFailureFact
  keptAsQueuedMessageId?: string
  /** Explicit null means no answered turn; absent is legacy. Unknown joins degrade to null. */
  answeredInTurn?: { turnItemId: string; via: string } | null
}

/** Per-mutation linkage supports mixed-agent creation; absent keeps the existing producer. */
export type JournalLifecycleMutation =
  | (AgentJournalProducerLinkage &
      JournalItemProvenance &
      JournalItemEcho & {
        kind: 'item'
        itemId: string
        revision: number
        body: AgentJournalItemBody
        turnScope?: AgentJournalTurnScope
        /** Source creation time; absent uses the batch row's timestamp. */
        observedAt?: number
      })
  | { kind: 'tombstone'; itemId: string; revision: number }

export type JournalLifecycleBatchRow = JournalRowBase & {
  kind: 'lifecycle-batch'
  settlementId: string
  mutations: JournalLifecycleMutation[]
}

export const MAX_JOURNAL_LIFECYCLE_BATCH_BYTES = 1_500_000
export const MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS = 200

export type JournalRow =
  | JournalTextDeltaRow
  | JournalEpochRow
  | JournalItemRow
  | JournalTombstoneRow
  | JournalSubmissionRow
  | JournalDispatchRow
  | JournalLifecycleBatchRow
  | JournalQueueRow

export type JournalRowParse =
  | { ok: true; row: JournalRow }
  | { ok: false; unreadable: false }
  /** Future content forbids writing/compacting this journal. */
  | { ok: false; unreadable: true }

export function serializeJournalRow(row: JournalRow): string {
  return JSON.stringify(row)
}

/**
 * Parse one persisted line. Older versions are upcast; newer versions and newer
 * kinds are reported as unreadable so the caller fails closed.
 */
export function parseJournalRow(line: string, preserveVersion = false): JournalRowParse {
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
  if (preserveVersion) {
    upcast.v = version
  }
  dropUnusableRowAnnotations(upcast)
  if (isJournalRow(upcast)) {
    return { ok: true, row: upcast }
  }
  return { ok: false, unreadable: journalRowContent(upcast) === 'unreadable' }
}

function upcastRow(record: Record<string, unknown>, version: number): Record<string, unknown> {
  // No shape converters yet: versions differ only in the kinds their readers understand.
  return { ...record, v: Math.max(version, AGENT_SESSION_JOURNAL_SCHEMA_VERSION) }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deep-check bodies before rendering; keep annotation enums open for compatible future values. */
function journalRowContent(record: Record<string, unknown>): AgentJournalContentVerdict {
  if (!hasJournalRowEnvelope(record)) {
    return 'malformed'
  }
  const { kind } = record
  const contentCheck = typeof kind === 'string' ? KNOWN_ROW_KINDS.get(kind) : undefined
  if (contentCheck) {
    return contentCheck(record)
  }
  return isJournalTag(kind) ? 'unreadable' : 'malformed'
}

function isJournalRow(record: Record<string, unknown>): record is JournalRow {
  return journalRowContent(record) === 'readable'
}

// Future content outranks adjacent corruption so unsupported history is never discarded.
function combinedContent(...verdicts: AgentJournalContentVerdict[]): AgentJournalContentVerdict {
  if (verdicts.includes('unreadable')) {
    return 'unreadable'
  }
  return verdicts.includes('malformed') ? 'malformed' : 'readable'
}

function fieldsContent(hold: boolean): AgentJournalContentVerdict {
  return hold ? 'readable' : 'malformed'
}

// Exhaustive kind keys make missing checks a compile error.
const ROW_CONTENT_CHECK_BY_KIND: Record<
  JournalRow['kind'],
  (record: Record<string, unknown>) => AgentJournalContentVerdict
> = {
  epoch: (record) =>
    fieldsContent(typeof record.reason === 'string' && isPlainObject(record.providerHandle)),
  item: (record) =>
    combinedContent(
      fieldsContent(typeof record.itemId === 'string' && Number.isInteger(record.revision)),
      readAgentJournalItemBody(record.body)
    ),
  tombstone: (record) =>
    fieldsContent(typeof record.itemId === 'string' && Number.isInteger(record.revision)),
  submission: (record) =>
    combinedContent(
      fieldsContent(
        typeof record.clientMessageId === 'string' &&
          record.clientMessageId.length > 0 &&
          typeof record.payloadFingerprint === 'string' &&
          isPlainObject(record.providerHandle)
      ),
      readAgentJournalMessageBody(record.body)
    ),
  dispatch: (record) =>
    fieldsContent(
      typeof record.clientMessageId === 'string' &&
        record.clientMessageId.length > 0 &&
        typeof record.state === 'string' &&
        record.state.length > 0 &&
        (record.providerItemId === null || typeof record.providerItemId === 'string') &&
        (record.reason === null || typeof record.reason === 'string')
    ),
  'lifecycle-batch': (record) => {
    const mutations = Array.isArray(record.mutations) ? record.mutations : []
    return combinedContent(
      fieldsContent(
        typeof record.settlementId === 'string' &&
          record.settlementId.length > 0 &&
          mutations.length > 0 &&
          mutations.length <= MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS &&
          Buffer.byteLength(JSON.stringify(record), 'utf8') + 1 <= MAX_JOURNAL_LIFECYCLE_BATCH_BYTES
      ),
      ...mutations.map((mutation) => lifecycleMutationContent(mutation))
    )
  },
  queue: journalQueueRowContent,
  'text-delta': (record) => fieldsContent(journalTextRowContent(record))
}
export const KNOWN_ROW_KINDS = new Map(Object.entries(ROW_CONTENT_CHECK_BY_KIND))

function hasJournalRowEnvelope(record: Record<string, unknown>): boolean {
  return (
    typeof record.epoch === 'string' &&
    record.epoch !== '' &&
    Number.isInteger(record.seq) &&
    Number(record.seq) >= 1 &&
    Number.isInteger(record.fence) &&
    typeof record.ts === 'number'
  )
}

const MUTATION_CONTENT_CHECK_BY_KIND: Record<
  JournalLifecycleMutation['kind'],
  (mutation: Record<string, unknown>) => AgentJournalContentVerdict
> = {
  item: (mutation) =>
    combinedContent(
      fieldsContent(typeof mutation.itemId === 'string' && Number.isInteger(mutation.revision)),
      readAgentJournalItemBody(mutation.body)
    ),
  tombstone: (mutation) =>
    fieldsContent(typeof mutation.itemId === 'string' && Number.isInteger(mutation.revision))
}
export const KNOWN_MUTATION_KINDS = new Map(Object.entries(MUTATION_CONTENT_CHECK_BY_KIND))

// Unknown mutation kinds require no fields specific to known mutations.
function lifecycleMutationContent(value: unknown): AgentJournalContentVerdict {
  if (!isPlainObject(value)) {
    return 'malformed'
  }
  const { kind } = value
  const contentCheck = typeof kind === 'string' ? KNOWN_MUTATION_KINDS.get(kind) : undefined
  if (contentCheck) {
    return contentCheck(value)
  }
  return isJournalTag(kind) ? 'unreadable' : 'malformed'
}

export function journalRowByteLength(row: JournalRow): number {
  return Buffer.byteLength(serializeJournalRow(row), 'utf8') + 1
}
