// Runs a user-defined local command as an ACP agent, with no agent-specific behavior.

import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import type { AcpAccountBinding } from '../launch/acp-account-binding'
import { GENERIC_ACP_DIALECT } from '../acp-dialects/acp-dialect'
import { directoryAccountBinding } from '../launch/acp-account-binding'
import type { StructuredAgentSessionHistory } from '../../native-chat/conversation-adoption/structured-agent-cli-conversations'
import type { CustomAcpAgent } from '../../../shared/agent-launch/custom-acp/custom-acp-agent'

// Orca knows nothing about where a custom agent keeps its sign-in, so chats pin only the user's
// home under a variable of Orca's own; the agent reads its usual store.
const CUSTOM_ACP_ACCOUNT: AcpAccountBinding = directoryAccountBinding(
  'ORCA_CUSTOM_ACP_HOME',
  (homePath) => homePath
)

// Session History reads no custom agent's store.
const CUSTOM_ACP_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: [],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: () => null
}

export function customAcpLaunchSpec(agent: CustomAcpAgent): AcpLaunchSpec {
  const args = [...agent.args]
  return {
    agent: agent.id,
    command: agent.command,
    // The command is the agent's whole identity; no terminal Command setting names it.
    ignoreAgentCommandSetting: true,
    args: () => [...args],
    env: { ...agent.env },
    dialect: GENERIC_ACP_DIALECT,
    loginCommand: [],
    account: CUSTOM_ACP_ACCOUNT,
    installDirectories: () => [],
    // A disposable session in a private folder; never in warm-up, only when someone asks for the list.
    modelDiscovery: {
      kind: 'session',
      listingNamesConfiguredModel: false,
      inPrivateFolder: true,
      listsOnDemand: true
    },
    transcriptImport: null,
    sessionHistory: CUSTOM_ACP_SESSION_HISTORY
  }
}
