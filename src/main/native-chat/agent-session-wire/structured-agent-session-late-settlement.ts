import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'

export type StructuredAgentSessionLateSettlement = {
  sessionId: string
  clientMessageId: string
} & (
  | { providerIdentity: AgentJournalItemIdentity }
  | { state: 'rejected'; reason: string }
  | { state: 'unknown'; reason: string; recovered: true; turnId: string }
)

export type StructuredAgentSessionLateSettlementResult =
  | 'settled'
  | 'no-obligation'
  | 'evidence-not-durable'

