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

/** Producer linkage rides the row BASE rather than the body: older builds read
 *  the two nested prompt shapes strictly, so an unknown key there made the whole
 *  row parse as malformed. It is also deliberately not a `v` bump — an
 *  unknown `v` makes a row unreadable (released older hosts keep the chat read-only;
 *  this build fails its load), while an unknown KEY is ignored below, so an older host reads a stamped row and
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
  /** Which turn the item this row creates belongs to. Rides the base, and is not a `v` bump,
   *  for the reason linkage does. Absent on rows from hosts that predate it: the reducer
   *  derives one for them on read. */
  turnScope?: AgentJournalTurnScope
}

/** First row of every epoch: binds the epoch to a provider handle and records why it opened. */
export type JournalEpochRow = JournalRowBase & {
  kind: 'epoch'
  reason: AgentJournalEpochReason
  providerHandle: AgentSessionJournalProviderHandle
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
  /** Present: not a removal but a Stop's event, on an id no item ever takes. */
  stopEvent?: JournalStopEvent
  /** Present: not a removal but a person's Resume of the queue, on an id no item ever takes. */
  queueResume?: true
}

/** One Stop that took effect. Temporary carrier: a tombstone's extra key, which every host ignores,
 *  where a host from before the header's rule deletes the journal from a kind it does not know. A
 *  kind of its own ships its reader first and is written once no supported build lacks that
 *  reader, or is written at a bumped `v`: an older host must never fold past a person's Stop. */
export type JournalStopEvent = {
  /** Persisted: never rename an arm. Only `user-stop` pauses the queue. */
  reason: StructuredAgentSessionStopCause
  /** The turn the Stop named, else the one running when it took effect. */
  turnId?: string
  /** When it took effect; a rewind's restatement keeps it. */
  at: number
  /** Who asked (`StructuredAgentSessionCaller.callerKey`). */
  caller?: string
}

/** A tombstone that carries a Stop event or a Resume mark instead of removing an item. */
export type JournalStopOrResumeRow = JournalTombstoneRow &
  (
    | { stopEvent: NonNullable<JournalTombstoneRow['stopEvent']> }
    | { queueResume: NonNullable<JournalTombstoneRow['queueResume']> }
  )

/** A Stop's event or a Resume. Any value counts, so a newer build's mark never removes an item. */
export function isJournalStopOrResumeRow(row: JournalRow): row is JournalStopOrResumeRow {
  return row.kind === 'tombstone' && (row.stopEvent !== undefined || row.queueResume !== undefined)
}

/** The write-ahead row. Durable BEFORE the adapter dispatches anything; it
 *  doubles as the optimistic user bubble so an accepted echo has a slot to
 *  reconcile into instead of appending a second copy. */
export type JournalSubmissionRow = JournalRowBase & {
  kind: 'submission'
  clientMessageId: string
  payloadFingerprint: string
  providerHandle: AgentSessionJournalProviderHandle
  body: AgentJournalMessageItem
  /** Accepted to be handed over by a later `dispatch{pending}` row; absent on rows whose writer
   *  dispatched in the same step. Older readers keep the key and ignore it. */
  handoverRecorded?: true
  /** The queued draft this submission hands off; absent for a direct send. Older readers keep
   *  the key and ignore it. */
  queuedMessageId?: string
  /** Who asked for this turn: `client` for a person's send over the client send RPC (typed, or
   *  a queued card they sent now); `host` for Orca's own — orchestration mail, a restart
   *  continuation, a launch prompt, the queue's automatic drain. Absent on rows from before it
   *  was recorded. Older readers keep the key and ignore it. */
  origin?: JournalSubmissionOrigin
}

export type JournalSubmissionOrigin = 'client' | 'host'

export type JournalDispatchRow = JournalRowBase & {
  kind: 'dispatch'
  clientMessageId: string
  state: AgentJournalDispatchState
  /** Provider item identity adopted on accept. */
  providerItemId: string | null
  reason: string | null
  /** On `pending`: the turn the message was handed into, which becomes its row's scope. */
  turnScope?: AgentJournalTurnScope
  /** On `rejected`: why, typed. Older readers keep the key and ignore it; a malformed one is
   *  dropped when read, never the row. */
  rejection?: AgentSessionFailureFact
  /** On `rejected`: the turn a Codex send was answered into, and how it joined it, when that
   *  turn's end settled the send; null on every other rejection. Absent on other rows and on rows
   *  written before it. `via` stays a string: a newer build may write another. Older readers keep
   *  the key and ignore it; one this build cannot read is read as null, never dropping the row. */
  answeredInTurn?: { turnItemId: string; via: string } | null
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
      turnScope?: AgentJournalTurnScope
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
  /** A future schema version, or a kind this build does not know. The host must not write or
   *  compact this journal. */
  | { ok: false; unreadable: true }

export function serializeJournalRow(row: JournalRow): string {
  return JSON.stringify(row)
}

/**
 * Parse one persisted line. Older versions are upcast; newer versions and newer
 * kinds are reported as unreadable so the caller fails closed.
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
  dropUnusableRowAnnotations(upcast)
  if (isJournalRow(upcast)) {
    return { ok: true, row: upcast }
  }
  return { ok: false, unreadable: journalRowContent(upcast) === 'unreadable' }
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
function journalRowContent(record: Record<string, unknown>): AgentJournalContentVerdict {
  if (!hasJournalRowEnvelope(record)) {
    return 'malformed'
  }
  const { kind } = record
  const contentCheck = typeof kind === 'string' ? KNOWN_ROW_KINDS.get(kind) : undefined
  if (contentCheck) {
    return contentCheck(record)
  }
  // A newer build's kind is placed by the envelope every row keeps.
  return isJournalTag(kind) ? 'unreadable' : 'malformed'
}

function isJournalRow(record: Record<string, unknown>): record is JournalRow {
  return journalRowContent(record) === 'readable'
}

/** A newer build's content anywhere wins over damage beside it: never delete what it wrote. */
function combinedContent(...verdicts: AgentJournalContentVerdict[]): AgentJournalContentVerdict {
  if (verdicts.includes('unreadable')) {
    return 'unreadable'
  }
  return verdicts.includes('malformed') ? 'malformed' : 'readable'
}

function fieldsContent(hold: boolean): AgentJournalContentVerdict {
  return hold ? 'readable' : 'malformed'
}

/** Each kind's own fields, keyed by every kind the union holds: a kind without a check here fails
 *  to compile, never reads as a newer build's kind. */
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
      ...mutations.map(lifecycleMutationContent)
    )
  }
}
export const KNOWN_ROW_KINDS = new Map(Object.entries(ROW_CONTENT_CHECK_BY_KIND))

/** The fields every row keeps whatever its kind: its epoch, its place in it, its writer, its time. */
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

/** Each mutation kind's own fields, keyed like the row kinds and for the same reason. */
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

/** The kind first: a newer build's kind needs none of the fields this build's kinds have. */
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

/** Approximate on-disk cost of a row, used for the per-session size bound. */
export function journalRowByteLength(row: JournalRow): number {
  return Buffer.byteLength(serializeJournalRow(row), 'utf8') + 1
}
