import { z } from 'zod'
import { AgentJournalTurnScopeSchema } from '../../../shared/agent-session-journal-schemas'
import { AgentSessionExecutionOptionsSchema } from '../../../shared/agent-session-execution-options'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'
import type { JournalHistoryOrigin } from './journal-history-origin'
import type { JournalStopEvent } from './journal-row-schema'
import {
  storedFailureFact,
  storedItem,
  storedMessageBody,
  storedProviderHandle,
  storedSubmission
} from './journal-storage-schema'
import {
  storageVerdict,
  strictStorage,
  type StorageDeclaresAll,
  type UndeclaredStorageKeys
} from './journal-storage-strict'

// Outcome format 1. A record keeps this meaning whatever the reducer becomes, and a build refuses a
// record holding a key it does not declare. So an added optional key needs no new format; a changed
// meaning, a removed or renamed key, a loosened type or a changed record key does, with its own
// records and decoder beside these. Its fields copy reducer bookkeeping, so changing what one of
// those means is a format change too. The golden fixture must keep decoding.
export const JOURNAL_OUTCOME_FORMAT_1 = 1

const number = z.number().finite()
const cursor = z.object({ epoch: z.string(), sequence: number })
const place = z.object({
  sequence: number,
  observedAt: number,
  turnScope: AgentJournalTurnScopeSchema.optional()
})
const pauseMarks = z.object({
  cleared: z
    .object({
      sequence: number,
      operationId: z.string(),
      messageIds: z.array(z.string()),
      lifted: z.literal(true).optional()
    })
    .optional(),
  latestStop: z
    .object({
      sequence: number,
      event: z.object({
        reason: z.string(),
        at: number,
        turnId: z.string().optional(),
        caller: z.string().optional()
      })
    })
    .nullable(),
  resumedSequence: number,
  reopenedSequence: number
})
const card = z.object({
  messageId: z.string(),
  position: number,
  body: storedMessageBody,
  fingerprint: z.string(),
  state: z.enum(['waiting', 'dispatched', 'returned', 'withdrawn']),
  holdReason: z.string().nullable(),
  returnedReason: z.string().nullable(),
  returnedRejection: storedFailureFact.nullable(),
  consumedAs: z.string().nullable(),
  queuedAt: cursor.nullable(),
  options: AgentSessionExecutionOptionsSchema.optional()
})
const receipt = z.object({
  clientMessageId: z.string(),
  providerItemId: z.string(),
  cursor,
  acceptedAt: number
})
const entry = <V extends z.ZodType>(value: V) => z.tuple([z.string(), value])
// Set members are stored as [value, value], as a Set's entries() yields them.
const member = (value: z.ZodString) =>
  z.tuple([value, value]).refine(([key, stored]) => key === stored)

/** What format 1 stores, as declared; reads admit values only through their strict forms. */
export const outcomeFormat1Stored = {
  items: storedItem,
  itemFences: entry(number),
  itemExecutionOwners: entry(number),
  providerActivityAt: z.tuple([number, number]),
  tombstones: entry(number),
  removedTurnIds: member(z.string()),
  submissions: entry(storedSubmission),
  receipts: entry(receipt),
  aliases: entry(z.string()),
  itemEchoes: z.union([z.tuple([z.string()]), z.tuple([z.string(), z.unknown()])]),
  appliedSettlementIds: member(z.string()),
  stoppedHistoryCarried: entry(z.array(z.string())),
  queuedHandOffPlaces: entry(place),
  normalizedHandOffs: member(z.string()),
  'queue.cards': entry(card)
}
export const outcomeFormat1StoredScalars = z.object({
  sessionId: z.string(),
  epoch: z.string(),
  lastSequence: z.number().int().nonnegative(),
  lastActivityAt: number,
  oldestSequence: number,
  highestFence: number,
  derivedTurnScope: z.string().nullable(),
  latestAcceptedTurnSequence: number,
  queuePauseMarks: pauseMarks,
  historyOrigin: z.object({ providerHandle: storedProviderHandle, raw: z.unknown() }).nullable(),
  queue: z.object({ revision: number })
})

/** Keyed collections, in the order the golden fixture pins. */
export const OUTCOME_FORMAT_1_COLLECTIONS = [
  'items',
  'itemFences',
  'itemExecutionOwners',
  'providerActivityAt',
  'tombstones',
  'removedTurnIds',
  'submissions',
  'receipts',
  'aliases',
  'itemEchoes',
  'appliedSettlementIds',
  'stoppedHistoryCarried',
  'queuedHandOffPlaces',
  'normalizedHandOffs',
  'queue.cards'
] as const satisfies readonly (keyof typeof outcomeFormat1Stored)[]

function checked<T>(schema: z.ZodType): z.ZodType<T> {
  // SAFETY: the strict schema admits only keys the type declares (checked at the end of this file);
  // decoding keeps the stored value as it is.
  const strict = strictStorage(schema)
  return z.custom<T>((value) => strict.safeParse(value).success)
}

type State = JournalReducerState
type Stored<F> = F extends Map<infer K, infer V> ? [K, V] : F extends Set<infer T> ? [T, T] : never
type Cards = State['queue']['cards']
const s = outcomeFormat1Stored
const scalar = outcomeFormat1StoredScalars.shape

/** Typed views of the stored schemas for decoding admitted records into reducer state. */
export const outcomeFormat1EntryParsers = {
  itemFences: checked<Stored<State['itemFences']>>(s.itemFences),
  itemExecutionOwners: checked<Stored<State['itemExecutionOwners']>>(s.itemExecutionOwners),
  providerActivityAt: checked<Stored<State['providerActivityAt']>>(s.providerActivityAt),
  tombstones: checked<Stored<State['tombstones']>>(s.tombstones),
  removedTurnIds: checked<Stored<State['removedTurnIds']>>(s.removedTurnIds),
  submissions: checked<Stored<State['submissions']>>(s.submissions),
  receipts: checked<Stored<State['receipts']>>(s.receipts),
  aliases: checked<Stored<State['aliases']>>(s.aliases),
  itemEchoes: checked<[string] | [string, unknown]>(s.itemEchoes),
  appliedSettlementIds: checked<Stored<State['appliedSettlementIds']>>(s.appliedSettlementIds),
  stoppedHistoryCarried: checked<Stored<State['stoppedHistoryCarried']>>(s.stoppedHistoryCarried),
  queuedHandOffPlaces: checked<Stored<State['queuedHandOffPlaces']>>(s.queuedHandOffPlaces),
  normalizedHandOffs: checked<Stored<State['normalizedHandOffs']>>(s.normalizedHandOffs),
  'queue.cards': checked<Stored<Cards>>(s['queue.cards'])
}
const p = outcomeFormat1EntryParsers
export const outcomeFormat1Fields = {
  ...outcomeFormat1StoredScalars.shape,
  items: z.array(checked<AgentJournalRenderItem>(s.items)),
  itemFences: z.array(p.itemFences),
  itemExecutionOwners: z.array(p.itemExecutionOwners),
  providerActivityAt: z.array(p.providerActivityAt),
  tombstones: z.array(p.tombstones),
  removedTurnIds: z.array(p.removedTurnIds),
  submissions: z.array(p.submissions),
  receipts: z.array(p.receipts),
  aliases: z.array(p.aliases),
  itemEchoes: z.array(p.itemEchoes),
  appliedSettlementIds: z.array(p.appliedSettlementIds),
  queuePauseMarks: checked<State['queuePauseMarks']>(scalar.queuePauseMarks),
  stoppedHistoryCarried: z.array(p.stoppedHistoryCarried),
  queuedHandOffPlaces: z.array(p.queuedHandOffPlaces),
  normalizedHandOffs: z.array(p.normalizedHandOffs),
  queue: z.object({ revision: number, cards: z.array(p['queue.cards']) }),
  historyOrigin: checked<State['historyOrigin']>(scalar.historyOrigin)
}
export const outcomeFormat1Scalars = outcomeFormat1StoredScalars.extend({
  queuePauseMarks: outcomeFormat1Fields.queuePauseMarks,
  historyOrigin: outcomeFormat1Fields.historyOrigin
})

/** The scalars as a whole, strict: a chat with no input prefix holds every one. */
export const outcomeFormat1StrictScalars = strictStorage(outcomeFormat1StoredScalars)
const strictly = (schemas: Record<string, z.ZodType>) =>
  new Map(Object.entries(schemas).map(([field, schema]) => [field, strictStorage(schema)]))
const collections = strictly(outcomeFormat1Stored)
const scalars = strictly(outcomeFormat1StoredScalars.shape)

/** A record's key and value as admission parsed and checked them; decoding takes them as they are. */
export type AdmittedOutcome = { readonly entryKey: unknown; readonly kept: unknown }

/** Admission: a field, scalar, key or union tag format 1 does not declare, at any depth, is a newer
 * writer's ('unknown'); content failing a declared type is damage and throws. An admitted value is
 * decoded as stored, never re-encoded through the schema, and never parsed or walked again. */
export function admitOutcomeFormat1(value: {
  field: string
  key: string
  json: string
  deleted: boolean
}): 'unknown' | AdmittedOutcome {
  const key: unknown = JSON.parse(value.key)
  const schema =
    value.field === '$'
      ? typeof key === 'string'
        ? scalars.get(key)
        : undefined
      : collections.get(value.field)
  if (!schema) {
    return 'unknown'
  }
  if (value.field === '$' ? value.deleted : typeof key !== 'string' && typeof key !== 'number') {
    throw new Error('invalid journal outcome key')
  }
  if (value.deleted) {
    return value.json === 'null' ? { entryKey: key, kept: null } : 'unknown'
  }
  const kept: unknown = JSON.parse(value.json)
  const verdict = storageVerdict(schema, kept)
  if (verdict !== 'stored') {
    if (verdict === 'newer') {
      return 'unknown'
    }
    throw new Error('invalid journal outcome value')
  }
  const storedKey = value.field === '$' ? key : value.field === 'items' ? itemId(kept) : first(kept)
  if (storedKey !== key) {
    throw new Error('mismatched journal outcome key')
  }
  return { entryKey: key, kept }
}

function itemId(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'itemId' in value ? value.itemId : undefined
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined
}

type Collection = (typeof OUTCOME_FORMAT_1_COLLECTIONS)[number]
type StoredIn<F> = F extends 'items'
  ? AgentJournalRenderItem
  : F extends 'queue.cards'
    ? Stored<Cards>
    : F extends keyof State
      ? Stored<State[F]>
      : never
type Marks = State['queuePauseMarks']
// Live Stop settlement is never stored (durableQueuePauseMarks).
type StoredMarks = Omit<Marks, 'latestStop'> & {
  latestStop: { sequence: number; event: JournalStopEvent } | null
}
type Scalars = z.output<typeof outcomeFormat1StoredScalars>
export type OutcomeFormat1DeclaresEveryKey = [
  StorageDeclaresAll<
    {
      [F in Collection]: UndeclaredStorageKeys<
        StoredIn<F>,
        z.output<(typeof outcomeFormat1Stored)[F]>
      >
    }[Collection]
  >,
  StorageDeclaresAll<UndeclaredStorageKeys<StoredMarks, Scalars['queuePauseMarks']>>,
  StorageDeclaresAll<UndeclaredStorageKeys<JournalHistoryOrigin, Scalars['historyOrigin']>>
]
