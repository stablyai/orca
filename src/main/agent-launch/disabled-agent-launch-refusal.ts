import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgentEnabled } from '../../shared/agent-launch/catalog/tui-agent-selection'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'

/** Refuses a new launch of an agent disabled in Settings → Agents, on any surface. */
export function assertTuiAgentLaunchEnabled(
  agent: TuiAgent,
  disabledTuiAgents: Iterable<unknown> | null | undefined
): void {
  if (!isTuiAgentEnabled(agent, disabledTuiAgents)) {
    throw new OrchestrationError(
      'agent_unconfigured',
      `Agent ${agent} is disabled. Choose an enabled agent.`
    )
  }
}
