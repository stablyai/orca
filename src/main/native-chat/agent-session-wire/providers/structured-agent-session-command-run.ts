import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalTurnItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'

/** The host creates the command’s running turn; the child translator ends it and writes its result. */
export type StructuredAgentSessionCommandRun = {
  clientMessageId: string
  turnId: string
  identity: AgentJournalItemIdentity
  resultIdentity: AgentJournalItemIdentity
  running: AgentJournalTurnItem
  /** Only agents declaring `compactInstructions` receive this. */
  instructions?: string
}
