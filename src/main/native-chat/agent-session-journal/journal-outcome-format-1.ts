import { z } from 'zod'
import {
  AgentJournalMessageBodySchema,
  AgentJournalRenderItemSchema,
  AgentJournalTurnScopeSchema
} from '../../../shared/agent-session-journal-schemas'
import { AgentJournalSubmissionSchema } from '../../../shared/agent-session-journal-submission-schema'
import { AgentSessionExecutionOptionsSchema } from '../../../shared/agent-session-execution-options'
import { AgentSessionFailureFactSchema } from '../../../shared/agent-session-failure-fact-schema'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'

// Outcome format 1 is frozen: a stored record keeps this meaning whatever the reducer or the cache
// codec become. Changing a field, a schema or the decoder is a new format with its own records; the
// schema fingerprint and golden fixture tests fail until that is done.
export const JOURNAL_OUTCOME_FORMAT_1 = 1

const number = z.number().finite()
const cursor = z.object({ epoch: z.string(), sequence: number })
const place = z.object({
  sequence: number,
  observedAt: number,
  turnScope: AgentJournalTurnScopeSchema.optional()
})
const handle = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('codex'), threadId: z.string() }),
  z.object({ kind: z.literal('claude'), sessionId: z.string(), leafUuid: z.string().nullable() }),
  z.object({ kind: z.literal('opaque'), agent: z.string(), value: z.string() })
])
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
  body: AgentJournalMessageBodySchema,
  fingerprint: z.string(),
  state: z.enum(['waiting', 'dispatched', 'returned', 'withdrawn']),
  holdReason: z.string().nullable(),
  returnedReason: z.string().nullable(),
  returnedRejection: AgentSessionFailureFactSchema.nullable(),
  consumedAs: z.string().nullable(),
  queuedAt: cursor.nullable(),
  options: AgentSessionExecutionOptionsSchema.optional()
})
const submission = AgentJournalSubmissionSchema.extend({
  acceptedSequence: number.optional(),
  origin: z.enum(['client', 'host']).optional()
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

/** What format 1 stores: each schema keeps exactly the fields this format defines. */
export const outcomeFormat1Stored = {
  items: AgentJournalRenderItemSchema,
  itemFences: entry(number),
  itemExecutionOwners: entry(number),
  providerActivityAt: z.tuple([number, number]),
  tombstones: entry(number),
  removedTurnIds: member(z.string()),
  submissions: entry(submission),
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
  historyOrigin: z.object({ providerHandle: handle, raw: z.unknown() }).nullable(),
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
  // SAFETY: each schema checks the stored shape; decoding keeps the stored value as it is.
  return z.custom<T>((value) => schema.safeParse(value).success)
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

const collections = new Map<string, z.ZodType>(Object.entries(outcomeFormat1Stored))
const scalars = new Map<string, z.ZodType>(Object.entries(outcomeFormat1StoredScalars.shape))

/** Admission: a record of a field or scalar format 1 does not define is a newer writer's ('unknown');
 * content failing a defined schema is damage and throws. An admitted value is decoded as stored, never
 * re-encoded through the schema. */
export function admitOutcomeFormat1(value: {
  field: string
  key: string
  json: string
  deleted: boolean
}): 'unknown' | undefined {
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
    return value.json === 'null' ? undefined : 'unknown'
  }
  const kept = schema.parse(JSON.parse(value.json))
  const storedKey = value.field === '$' ? key : value.field === 'items' ? itemId(kept) : first(kept)
  if (storedKey !== key) {
    throw new Error('mismatched journal outcome key')
  }
  return undefined
}

function itemId(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'itemId' in value ? value.itemId : undefined
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined
}
