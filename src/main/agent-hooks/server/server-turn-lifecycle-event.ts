import type { AgentStatusRunVerdict } from '../../../shared/agent-status-run'
import type { AgentTurnLifecycleEvent, AgentTurnOwner } from '../../../shared/agent-turn-lifecycle'

export function agentExecutionVerdictEvent(
  owner: AgentTurnOwner,
  verdict: AgentStatusRunVerdict,
  observedAt: number
): AgentTurnLifecycleEvent {
  return {
    kind: 'execution-verdict-observed',
    owner,
    verdict,
    evidence: {
      eventId: `execution-verdict:${verdict}:${observedAt}`,
      producerId: 'orc:execution-host',
      observedAt
    }
  }
}
