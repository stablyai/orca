// Why a connector conversation's agent couldn't do what was asked, from the chat's typed failure facts
// (never its text), in the categories the connectors word.
import type {
  AgentSessionFailureFact,
  AgentSessionFailureKind
} from '../../shared/agent-session/failures/agent-session-failure'
import type {
  ConnectorFailure,
  ConnectorFailureCategory
} from '../../shared/connectors/connector-cloud-contract'
import { tuiAgentDisplayName } from '../../shared/agent-launch/catalog/tui-agent-display-names'

// Each a different next step for the owner; any other kind is the agent's own error.
const CATEGORY_OF: Partial<Record<AgentSessionFailureKind, ConnectorFailureCategory>> = {
  notSignedIn: 'signed_out',
  usageLimitReached: 'usage_limit',
  cliMissing: 'not_set_up',
  runtimeNotInstalled: 'not_set_up',
  agentCommandNotRunnable: 'not_set_up',
  claudeAccountFolderMissing: 'not_set_up',
  claudeAccountSetupFailed: 'not_set_up',
  claudeAccountBindingUnavailable: 'not_set_up',
  launchFolderMissing: 'folder_missing'
}

export function connectorFailure(
  fact: AgentSessionFailureFact | undefined,
  agent: string
): ConnectorFailure {
  const agentName = tuiAgentDisplayName(agent)
  const limit = fact?.kind === 'usageLimitReached' ? fact.usageLimit : undefined
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return {
    category: (fact && CATEGORY_OF[fact.kind]) ?? 'agent_error',
    ...(agentName ? { agentName } : {}),
    ...(limit ? { usageLimit: limit } : {}),
    ...(timeZone ? { timeZone } : {})
  }
}
