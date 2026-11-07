import type {
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import type { QueuedMessageOwed } from './queued-messages/queued-message-consume-error'
import type { JournalGoalAttachmentSnapshot } from './writing/journal-goal-attachment-inverse'
import type { UsageLimitContinueIdentity } from '../../../shared/agent-session/lifecycle/agent-session-usage-limit-continue'
import type { JournalWriterEffect } from './journal-writer-effects'

export type JournalWriterStoreEffect = Extract<JournalWriterEffect, { kind: 'store' }>

/** Host-memory facts a command needs; the writer never calls back into the host mid-transaction. */
export type JournalWriterHostFacts = {
  identity: AgentSessionJournalIdentity
  /** This handle's unmarked reopen boundary. */
  reopenFloor?: AgentJournalCursor | null
  editHeld?: readonly string[]
  /** Orchestration senders (by `journalMailSenderKey`) and whether their mail is unavailable now. */
  mail?: readonly (readonly [string, boolean])[]
  /** The handover answer, asked only after the writer validated the consumed card. */
  owed?: QueuedMessageOwed
  goals?: JournalGoalAttachmentSnapshot
  /** The host keeps a record store, so a commit that reveals a stopped cut withdraws it. */
  withdrawsStoppedCuts?: true
  /** The host's staged withdrawal for that cut; null when its record already withdrew it. */
  stoppedCut?: { cut: UsageLimitContinueIdentity; store: JournalWriterStoreEffect | null }
}

export type JournalHostFactsNeeded = {
  mail?: AgentMessageSource[]
  owed?: true
  stoppedCut?: UsageLimitContinueIdentity
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
