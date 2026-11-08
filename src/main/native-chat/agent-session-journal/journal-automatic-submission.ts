import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import type { StructuredMessageSteeringInputs } from '../../../shared/agent-session/options/codex-message-compiler'
import type { JournalCurrentWorkAuthority } from './journal-observer-read'
import type { JournalSqlFailure } from './journal-sql-failure'
import type { QueuedMessageOwed } from './queued-messages/queued-message-consume-error'

/** Only external owner observations cross the port; SQL derives work and card eligibility. */
export type JournalAutomaticSelection = {
  authority: JournalCurrentWorkAuthority
  child: {
    fence: number
    acquisitionGeneration: string | null
    ready: boolean
    closing: boolean
    stopping: boolean
  } | null
  steering: StructuredMessageSteeringInputs
}

export type JournalAutomaticPreparation = {
  sessionId: string
  epoch: string
  handle: string
  queueRevision: number
  mail: { messageId: string; revision: number; source: AgentMessageSource } | null
}

export type JournalAutomaticSubmissionFacts = {
  selectionNow: number
  selection: JournalAutomaticSelection
  preparation: JournalAutomaticPreparation
  owed: QueuedMessageOwed
}

export type JournalAutomaticSubmissionResult =
  | { kind: 'waiting' }
  | { kind: 'changed'; retry: boolean }
  | { kind: 'withdrawn'; messageId: string }
  | { kind: 'claimed'; messageId: string; clientMessageId: string }
  | { kind: 'failed'; messageId: string; failure: JournalSqlFailure }
