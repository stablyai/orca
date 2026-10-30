import { z } from 'zod'
import {
  isAdmissibleAgentJournalRenderItem,
  isAdmissibleAgentJournalMessageBody,
  AgentJournalTurnScopeSchema
} from '../../../shared/agent-session-journal-schemas'
import { AgentJournalSubmissionSchema } from '../../../shared/agent-session-journal-submission-schema'
import { AgentSessionExecutionOptionsSchema } from '../../../shared/agent-session-execution-options'
import { AgentSessionFailureFactSchema } from '../../../shared/agent-session-failure-fact-schema'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import type { QueuedMessageRow } from './queued-message-table'
import type { JournalReducerState } from './journal-reducer'

// Outcome format 1 is frozen: stored outcomes keep this meaning whatever the reducer or the cache
// codec become. Changing a field, a schema or the decoder is a new format, which the founding
// sentinel makes older readers refuse; the golden fixture test fails until that is done.
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
  body: z.custom<AgentJournalMessageItem>(isAdmissibleAgentJournalMessageBody),
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

function checked<T>(schema: z.ZodType): z.ZodType<T> {
  // SAFETY: each schema below checks the stored shape; retain the original object, including unknown annotations.
  return z.custom<T>((value) => schema.safeParse(value).success)
}

function entries<T>(value: z.ZodType<T>) {
  return z.array(z.tuple([z.string(), value]))
}

export const outcomeFormat1Fields = {
  sessionId: z.string(),
  epoch: z.string(),
  lastSequence: z.number().int().nonnegative(),
  lastActivityAt: number,
  oldestSequence: number,
  highestFence: number,
  items: z.array(z.custom<AgentJournalRenderItem>(isAdmissibleAgentJournalRenderItem)),
  itemFences: entries(number),
  itemExecutionOwners: entries(number),
  providerActivityAt: z.array(z.tuple([number, number])),
  tombstones: entries(number),
  removedTurnIds: z.array(z.string()),
  submissions: entries(checked<AgentJournalSubmission>(submission)),
  receipts: entries(
    z.object({
      clientMessageId: z.string(),
      providerItemId: z.string(),
      cursor,
      acceptedAt: number
    })
  ),
  aliases: entries(z.string()),
  itemEchoes: z.array(z.union([z.tuple([z.string()]), z.tuple([z.string(), z.unknown()])])),
  appliedSettlementIds: z.array(z.string()),
  derivedTurnScope: z.string().nullable(),
  latestAcceptedTurnSequence: number,
  queuePauseMarks: checked<JournalReducerState['queuePauseMarks']>(pauseMarks),
  stoppedHistoryCarried: entries(z.array(z.string())),
  queuedHandOffPlaces: entries(
    checked<Pick<AgentJournalRenderItem, 'sequence' | 'observedAt' | 'turnScope'>>(place)
  ),
  normalizedHandOffs: z.array(z.string()),
  queue: z.object({
    revision: number,
    cards: entries(checked<QueuedMessageRow>(card))
  }),
  historyOrigin: checked<JournalReducerState['historyOrigin']>(
    z
      .object({
        providerHandle: handle,
        raw: z.unknown()
      })
      .nullable()
  )
}
export const outcomeFormat1Scalars = z
  .object(outcomeFormat1Fields)
  .pick({
    sessionId: true,
    epoch: true,
    lastSequence: true,
    lastActivityAt: true,
    oldestSequence: true,
    highestFence: true,
    derivedTurnScope: true,
    latestAcceptedTurnSequence: true,
    queuePauseMarks: true,
    historyOrigin: true
  })
  .extend({ queue: outcomeFormat1Fields.queue.pick({ revision: true }) })

const fields = outcomeFormat1Fields
/** Keyed collections. Entries are stored as [key, value] for maps, [value, value] for sets, and [key]
 * for an echo declared undefined. */
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
] as const
type CollectionPath = (typeof OUTCOME_FORMAT_1_COLLECTIONS)[number]
const setEntry = <T>(element: z.ZodType<T>) =>
  z
    .array(z.unknown())
    .min(1)
    .max(2)
    .transform((entry, context): [T] => {
      const parsed = element.safeParse(entry[0])
      if (!parsed.success) {
        context.addIssue({ code: 'custom', message: 'invalid journal set entry' })
        return z.NEVER
      }
      return [parsed.data]
    })
export const outcomeFormat1EntryParsers = {
  itemFences: fields.itemFences.element,
  itemExecutionOwners: fields.itemExecutionOwners.element,
  providerActivityAt: fields.providerActivityAt.element,
  tombstones: fields.tombstones.element,
  removedTurnIds: setEntry(fields.removedTurnIds.element),
  submissions: fields.submissions.element,
  receipts: fields.receipts.element,
  aliases: fields.aliases.element,
  itemEchoes: fields.itemEchoes.element,
  appliedSettlementIds: setEntry(fields.appliedSettlementIds.element),
  stoppedHistoryCarried: fields.stoppedHistoryCarried.element,
  queuedHandOffPlaces: fields.queuedHandOffPlaces.element,
  normalizedHandOffs: setEntry(fields.normalizedHandOffs.element),
  'queue.cards': fields.queue.shape.cards.element
} satisfies Record<Exclude<CollectionPath, 'items'>, z.ZodType>
const parsers = new Map<string, z.ZodType>(Object.entries(outcomeFormat1EntryParsers))
const scalarShape = new Map<string, z.ZodType>(Object.entries(outcomeFormat1Scalars.shape))

/** A field or scalar key format 1 does not define can come only from a writer that skipped a
 * format change; content failing a defined schema is damage. */
export function validateOutcomeFormat1(value: {
  field: string
  key: string
  json: string
  deleted: boolean
}): 'unknown' | undefined {
  const key: unknown = JSON.parse(value.key)
  if (value.field === '$') {
    const schema = typeof key === 'string' ? scalarShape.get(key) : undefined
    if (!schema) {
      return 'unknown'
    }
    if (value.deleted) {
      throw new Error('invalid journal scalar outcome')
    }
    schema.parse(JSON.parse(value.json))
    return undefined
  }
  const parser = parsers.get(value.field)
  if (!parser && value.field !== 'items') {
    return 'unknown'
  }
  if (typeof key !== 'string' && typeof key !== 'number') {
    throw new Error('invalid journal collection outcome')
  }
  if (value.deleted) {
    return undefined
  }
  const decoded: unknown = JSON.parse(value.json)
  const stored = parser ? parser.parse(decoded) : [fields.items.element.parse(decoded).itemId]
  if (!Array.isArray(stored) || JSON.stringify(stored[0]) !== value.key) {
    throw new Error('mismatched journal outcome key')
  }
  return undefined
}
