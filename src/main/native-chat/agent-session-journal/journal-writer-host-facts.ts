import type { JournalCurrentWorkAuthority } from './journal-observer-read'
import type {
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import type { QueuedMessageOwed } from './queued-messages/queued-message-consume-error'
import type { JournalGoalAttachmentSnapshot } from './writing/journal-goal-attachment-inverse'
import type { UsageLimitContinueIdentity } from '../../../shared/agent-session/lifecycle/stopping/agent-session-usage-limit-continue'
import type { JournalWriterEffect } from './journal-writer-effects'
import type { JournalStopSettle } from './queued-messages/queued-message-pause-marks'
import type { JournalAutomaticSubmissionFacts } from './journal-automatic-submission'

export type JournalMailCustody = readonly (readonly [string, QueuedMessageOwed])[]

export type JournalWriterStoreEffect = Extract<JournalWriterEffect, { kind: 'store' }>

/** Host-memory facts a command needs; the writer never calls back into the host mid-transaction. */
export type JournalWriterHostFacts = {
  identity: AgentSessionJournalIdentity
  automatic?: JournalAutomaticSubmissionFacts
  send?: JournalCurrentWorkAuthority
  /** Physical admission boundary captured after ready and before this opening's recovery. */
  openedThrough?: AgentJournalCursor
  /** This handle's unmarked reopen boundary. */
  reopenFloor?: AgentJournalCursor | null
  /** Orchestration senders (by `journalMailSenderKey`) and whether their mail is still owed. */
  mail?: JournalMailCustody
  /** The handover answer, asked only after the writer validated the consumed card. */
  owed?: QueuedMessageOwed
  goals?: JournalGoalAttachmentSnapshot
  /** The host keeps a record store, so a commit that reveals a stopped cut withdraws it. */
  withdrawsStoppedCuts?: true
  /** The host's staged withdrawal for that cut; null when its record already withdrew it. */
  stoppedCut?: { cut: UsageLimitContinueIdentity; store: JournalWriterStoreEffect | null }
  /** What a rewind or replacement left, for the host's staged completion receipt. */
  rewound?: JournalRewoundFacts
  /** The host's unsaved settlement of the latest Stop, named by that Stop's sequence. */
  stopSettle?: JournalStopSettleFact
}

export type JournalStopSettleFact = { sequence: number; settle: JournalStopSettle }

export type JournalRewoundFacts = {
  cursor: AgentJournalCursor
  cancel: UsageLimitContinueIdentity | null
}

export type JournalHostFactsNeeded = {
  mail?: AgentMessageSource[]
  owed?: true
  stoppedCut?: UsageLimitContinueIdentity
  rewound?: JournalRewoundFacts
}

/** The command rolled back without effects; the host answers and resends it on the same lane. */
export class JournalHostFactsNeededError extends Error {
  override readonly name = 'JournalHostFactsNeededError'

  constructor(readonly needs: JournalHostFactsNeeded) {
    super('journal command needs host facts')
  }
}

export function journalMailSenderKey(from: AgentMessageSource): string {
  return JSON.stringify(from)
}
