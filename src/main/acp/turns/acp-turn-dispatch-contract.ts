import type { SubmissionRejectionFact } from '../../../shared/agent-session/failures/agent-session-failure'
import type { AgentJournalDispatchRejection } from '../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AcpAgentError } from '../transport/acp-errors'
import type { AcpStructuredConnection } from '../process/acp-structured-connection'
import type { AcpStructuredLane } from '../journal/acp-structured-lane'

export type AcpDispatchSettlement = { clientMessageId: string } & (
  | { providerIdentity: AgentJournalItemIdentity }
  | ({ state: 'rejected' } & AgentJournalDispatchRejection)
  | { state: 'unknown'; reason: string }
)

export type AcpStructuredTurnsDeps = {
  connection: Pick<AcpStructuredConnection, 'prompt' | 'cancel'>
  withdrawRequests: () => void
  lane: AcpStructuredLane
  agentName: string
  now: () => number
  settle: (settlement: AcpDispatchSettlement) => void
  /** Replace the child so the next send reopens the session. */
  sessionLost: (error: Error) => void
  /** The agent had no model for the prompt, which it may word like a sign-in failure. */
  modelRefusal?: (error: AcpAgentError) => SubmissionRejectionFact | undefined
}
