import { z } from 'zod'
import {
  AgentJournalProducerLinkageFields,
  AgentJournalTurnScopeSchema
} from '../../../shared/agent-session-journal-schemas'
import type { JournalRow } from './journal-row-schema'
import {
  storedFailureFact,
  storedItemBody,
  storedMessageBody,
  storedProviderHandle
} from './journal-storage-schema'
import {
  storageVerdict,
  strictStorage,
  type StorageDeclaresAll,
  type UndeclaredStorageKeys
} from './journal-storage-strict'

// Every key an input row may hold. Only builds before outcome records wrote input rows, so a key
// this build does not declare is refused before main's reader normalizes it away; values keep
// main's checks (scalars here are unchecked), and execution options keep their legacy meaning of
// ignoring keys this build does not use.

const value = z.unknown().optional()
const envelope = {
  v: value,
  epoch: value,
  seq: value,
  fence: value,
  ts: value,
  recovered: value,
  turnScope: AgentJournalTurnScopeSchema.optional(),
  ...AgentJournalProducerLinkageFields
}
const provenance = { ownerFence: value, executionOwner: value, echoOf: value }
const legacyOptions = z.record(z.string(), z.unknown()).optional()

const itemMutation = {
  kind: z.literal('item'),
  itemId: value,
  revision: value,
  body: storedItemBody,
  turnScope: AgentJournalTurnScopeSchema.optional(),
  observedAt: value,
  ...provenance,
  ...AgentJournalProducerLinkageFields
}
const tombstoneMutation = { kind: z.literal('tombstone'), itemId: value, revision: value }

const queueChange = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('queued'),
    body: storedMessageBody,
    position: value,
    queuedAt: z.object({ epoch: value, sequence: value }).nullable(),
    holdReason: value,
    options: legacyOptions,
    attempt: value,
    returned: z.object({ reason: value, rejection: storedFailureFact.optional() }).optional()
  }),
  z.object({ op: z.literal('edited'), body: storedMessageBody }),
  z.object({ op: z.literal('moved'), position: value }),
  z.object({ op: z.literal('held'), holdReason: value }),
  z.object({ op: z.literal('withdrawn') })
])

const storedRow = z.discriminatedUnion('kind', [
  z.object({
    ...envelope,
    kind: z.literal('epoch'),
    inputOrderLineage: value,
    reason: value,
    providerHandle: storedProviderHandle,
    historyOrigin: value
  }),
  z.object({
    ...envelope,
    ...provenance,
    kind: z.literal('item'),
    itemId: value,
    revision: value,
    body: storedItemBody
  }),
  z.object({
    ...envelope,
    kind: z.literal('tombstone'),
    itemId: value,
    revision: value,
    stopEvent: z.object({ reason: value, turnId: value, at: value, caller: value }).optional(),
    queueResume: value,
    queueReopen: value,
    queueReopenSince: value,
    queueClear: z
      .object({ operationId: value, messageIds: z.array(value), lifted: value })
      .optional(),
    retireSubmission: value
  }),
  z.object({
    ...envelope,
    kind: z.literal('submission'),
    inputOrderContext: value,
    clientMessageId: value,
    payloadFingerprint: value,
    providerHandle: storedProviderHandle,
    body: storedMessageBody,
    handoverRecorded: value,
    queuedMessageId: value,
    origin: value,
    source: z.object({ kind: value }).optional(),
    options: legacyOptions
  }),
  z.object({
    ...envelope,
    kind: z.literal('dispatch'),
    clientMessageId: value,
    state: value,
    providerItemId: value,
    reason: value,
    carries: z.array(value).optional(),
    rejection: storedFailureFact.optional(),
    keptAsQueuedMessageId: value,
    answeredInTurn: z.object({ turnItemId: value, via: value }).nullable().optional()
  }),
  z.object({
    ...envelope,
    kind: z.literal('lifecycle-batch'),
    settlementId: value,
    mutations: z.array(
      z.discriminatedUnion('kind', [z.object(itemMutation), z.object(tombstoneMutation)])
    )
  }),
  z.object({ ...envelope, kind: z.literal('queue'), messageId: value, change: queueChange })
])
const strictRow = strictStorage(storedRow)

/** True when an input row holds a key or union tag this build does not declare; main's reader
 * judges every value. */
export function journalRowDeclaresMore(row: unknown): boolean {
  return storageVerdict(strictRow, row) === 'newer'
}

export type JournalRowsAreDeclared = StorageDeclaresAll<
  UndeclaredStorageKeys<JournalRow, z.output<typeof storedRow>>
>
