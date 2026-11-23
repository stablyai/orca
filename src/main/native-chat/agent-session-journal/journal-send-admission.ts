import type { AgentSessionSendResult } from '../../../shared/agent-session/agent-session-wire'
import type { AgentMessageSource } from '../../../shared/agent-session/journal/agent-session-message-source'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { JournalSubmissionInput } from './journal-store-contracts'

export type JournalSendAdmission = {
  input: JournalSubmissionInput
  fromPerson: boolean
  fromAgent: boolean
  deliveryMode: 'queue' | 'steer'
  queueOnly?: true
  continuationOfTurnItemId?: string
  /** The running agent still owes work on an account the chat is leaving: a send not from another
   *  agent waits as a card until a start on the new account can take it. */
  awaitsAccountMove?: true
  /** The person's cards wait for the move while this send goes ahead of them, so they don't
   *  count as the chat having moved on. */
  passesHeldCards?: true
}

export type JournalSendAdmissionResult =
  | { kind: 'admitted'; value: AgentSessionSendResult }
  | { kind: 'immediate' }
  | { kind: 'refused'; refusal: AgentSessionWireRefusal }
  | { kind: 'needs-custody'; source: AgentMessageSource }
