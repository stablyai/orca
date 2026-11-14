import type { AgentSessionSendResult } from '../../../shared/agent-session/agent-session-wire'
import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { JournalSubmissionInput } from './journal-store-contracts'

export type JournalSendAdmission = {
  input: JournalSubmissionInput
  fromPerson: boolean
  fromAgent: boolean
  deliveryMode: 'queue' | 'steer'
  queueOnly?: true
  continuationOfTurnItemId?: string
}

export type JournalSendAdmissionResult =
  | { kind: 'admitted'; value: AgentSessionSendResult }
  | { kind: 'immediate' }
  | { kind: 'refused'; refusal: AgentSessionWireRefusal }
  | { kind: 'needs-custody'; source: AgentMessageSource }
