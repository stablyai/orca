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

// Every reducer key must have an explicit stored representation, including separately stored items.
export const fields = {
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
} satisfies Record<keyof JournalReducerState, z.ZodType>
export const scalarsV2 = z
  .object(fields)
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
  .extend({ queue: fields.queue.pick({ revision: true }) })
