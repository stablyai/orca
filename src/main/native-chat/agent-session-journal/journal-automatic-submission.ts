import type { AgentMessageSource } from '../../../shared/agent-session/journal/agent-session-message-source'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredMessageSteeringInputs } from '../../../shared/agent-session/options/codex-message-compiler'
import type { JournalCurrentWorkAuthority } from './journal-observer-read'
import type { JournalSqlFailure } from './journal-sql-failure'

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
  /** Whether other agents' mail may join a running turn. False where the provider can only take a
   *  new message by cancelling its prompt (`steering: 'queue'`); that mail waits for the turn's end. */
  mailJoinsTurn: boolean
}

/** The queued card a host guard passed; a guarded claim takes only this card. */
export type JournalAutomaticAdmission = { messageId: string; fingerprint: string }

/** A host's guard on the card a claim would take, asked within the claim's lane; false refuses it. */
export type JournalAutomaticAdmit = (
  card: Extract<JournalAutomaticSubmissionResult, { kind: 'needs-admission' }>
) => boolean

export type JournalAutomaticSubmissionFacts = {
  selectionNow: number
  selection: JournalAutomaticSelection
  /** Present when the host guards each card: the card it passed, or null before any. */
  admitted?: JournalAutomaticAdmission | null
}

export type JournalAutomaticSubmissionResult =
  | { kind: 'waiting' }
  | { kind: 'needs-custody'; source: AgentMessageSource }
  | { kind: 'withdrawn'; messageId: string }
  /** The claim would take a card the host's guard has not passed, or refused. */
  | {
      kind: 'needs-admission'
      messageId: string
      fingerprint: string
      body: AgentJournalMessageItem
    }
  | {
      kind: 'claimed'
      messageId: string
      clientMessageId: string
      body: AgentJournalMessageItem
      /** Handed into the running turn rather than opening one. */
      steer: boolean
    }
  | { kind: 'failed'; messageId: string; failure: JournalSqlFailure }
