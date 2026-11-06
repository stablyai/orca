import type {
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import type { QueuedMessageOwed } from './queued-message-consume-error'
import type { JournalGoalAttachmentSnapshot } from './journal-goal-attachment-inverse'

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
}

export type JournalHostFactsNeeded = { mail?: AgentMessageSource[]; owed?: true }

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
