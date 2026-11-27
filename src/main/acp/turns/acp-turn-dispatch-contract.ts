import type { SubmissionRejectionFact } from '../../../shared/agent-session/failures/agent-session-failure'
import type { AgentJournalDispatchRejection } from '../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AcpAgentError } from '../transport/acp-errors'
import type { AcpStructuredConnection } from '../process/acp-structured-connection'
import type { AcpStructuredLane } from '../journal/acp-structured-lane'
import type { AgentJournalAnsweredTurnIdentity } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { ContentBlock } from '../generated/acp-protocol.generated'

export type AcpDispatchSettlement = { clientMessageId: string } & (
  | {
      providerIdentity: AgentJournalItemIdentity
      answeredInTurn?: AgentJournalAnsweredTurnIdentity
    }
  | ({ state: 'rejected' } & AgentJournalDispatchRejection)
  | { state: 'unknown'; reason: string }
)

// `adopted`: an earlier app's prompt, whose acceptance no replay settles.
export type AcpTurnSend = {
  clientMessageId: string
  prompt: ContentBlock[]
  requestedAt: number
  adopted?: true
}
export type AcpSteerMode = 'mail' | 'cancel'

export type AcpStructuredTurnsDeps = {
  connection: Pick<AcpStructuredConnection, 'prompt' | 'cancel' | 'requestExtension'>
  steeringSessionId?: string
  withdrawRequests: () => void
  lane: AcpStructuredLane
  agentName: string
  /** The agent's own command for /compact. */
  compactCommand?: string
  now: () => number
  settle: (settlement: AcpDispatchSettlement) => void
  /** Replace the child so the next send reopens the session. */
  sessionLost: (error: Error) => void
  /** The agent had no model for the prompt, which it may word like a sign-in failure. */
  modelRefusal?: (error: AcpAgentError) => SubmissionRejectionFact | undefined
}
