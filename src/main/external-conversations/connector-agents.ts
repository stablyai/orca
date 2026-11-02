import type { ConnectorAgent } from '../../shared/external-conversation-link'
import {
  isAgentStatusHooksEnabledForAgent,
  type AgentStatusHooksSettings
} from '../../shared/agent-status-hooks-setting'

// Membership records mid-turn terminal input support until capability data covers it.
export const CONNECTOR_AGENTS = ['claude', 'codex'] as const satisfies readonly ConnectorAgent[]

export function admitConnectorAgent(
  settings: AgentStatusHooksSettings,
  agent: string
): agent is ConnectorAgent {
  return CONNECTOR_AGENTS.some(
    (candidate) => candidate === agent && isAgentStatusHooksEnabledForAgent(settings, candidate)
  )
}
