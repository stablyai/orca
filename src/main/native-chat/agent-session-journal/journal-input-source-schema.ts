import { z } from 'zod'
import {
  AgentJournalProducerLinkageFields,
  AgentJournalTurnScopeSchema
} from '../../../shared/agent-session-journal-schemas'
import { AgentSessionExecutionOptionsSchema } from '../../../shared/agent-session-execution-options'
import {
  storedItem,
  storedMessageBody,
  storedProviderHandle,
  storedSubmission
} from './journal-storage-schema'
import { strictStorage } from './journal-storage-strict'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { JournalSubmissionRow } from './journal-row-schema'

const number = z.number().finite()
const sequence = z.number().int().positive()
export const journalSubmissionSource = z.object({
  kind: z.literal('submission'),
  v: z.number().int().positive(),
  epoch: z.string(),
  seq: sequence,
  fence: number,
  ts: number,
  recovered: z.literal(true).optional(),
  turnScope: AgentJournalTurnScopeSchema.optional(),
  ...AgentJournalProducerLinkageFields,
  clientMessageId: z.string(),
  payloadFingerprint: z.string(),
  providerHandle: storedProviderHandle,
  body: storedMessageBody,
  handoverRecorded: z.literal(true).optional(),
  queuedMessageId: z.string().optional(),
  origin: z.enum(['client', 'host']).optional(),
  source: z.object({ kind: z.string() }).optional(),
  options: AgentSessionExecutionOptionsSchema.optional()
})

// Historical admissions retain only the evidence their writer actually saved.
export const journalAdmissionSource = z.object({
  kind: z.literal('outcome-admission'),
  epoch: z.string(),
  sequence,
  item: storedItem,
  submission: storedSubmission,
  fence: number
})
export const journalInputSource = z.discriminatedUnion('kind', [
  journalSubmissionSource,
  journalAdmissionSource
])
export const strictJournalInputSource = strictStorage(journalInputSource)
export type JournalHistoricalAdmissionSource = {
  kind: 'outcome-admission'
  epoch: string
  sequence: number
  item: AgentJournalRenderItem
  submission: AgentJournalSubmission
  fence: number
}
export type JournalInputSource = JournalSubmissionRow | JournalHistoricalAdmissionSource
