import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentSessionDispatchOutcome } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { acpAgentName } from '../session/acp-structured-agent-definitions'
import type { AcpStructuredSession } from '../session/acp-structured-session-contract'

/** Only for a send refused before its prompt was written. */
export function rejectedAcpDispatch(
  session: Pick<AcpStructuredSession, 'spec'>
): AgentSessionDispatchOutcome {
  return {
    state: 'rejected',
    ...agentSessionFailureWords(
      agentSessionFailureFact('providerExited', { neverReachedAgent: true }),
      { surface: 'rejection', agentName: acpAgentName(session.spec.agent) }
    )
  }
}
