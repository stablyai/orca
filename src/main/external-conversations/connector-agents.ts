import type { ConnectorAgent } from '../../shared/external-conversation-link'
import {
  isAgentStatusHooksEnabledForAgent,
  type AgentStatusHooksSettings
} from '../../shared/agent-status-hooks-setting'

/**
 * The one list of agents a connector may start. Each needs hook status reporting (checked below)
 * and a terminal that takes input mid-turn; no capability data records the latter for terminals
 * yet, so membership here is where that fact lives.
 */
export const CONNECTOR_AGENTS = ['claude', 'codex'] as const satisfies readonly ConnectorAgent[]

export function admitConnectorAgent(
  settings: AgentStatusHooksSettings,
  agent: string
): agent is ConnectorAgent {
  return CONNECTOR_AGENTS.some(
    (candidate) => candidate === agent && isAgentStatusHooksEnabledForAgent(settings, candidate)
  )
}
