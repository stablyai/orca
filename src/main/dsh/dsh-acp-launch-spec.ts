import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { DSH_ACP_DIALECT } from '../acp/acp-dialects/dsh-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import type { StructuredAgentSessionHistory } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

const DSH_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: [],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: () => null
}

export const DSH_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'dsh',
  command: 'dsh',
  // The terminal agent's Command setting runs `dsh-tui`, not the official `dsh` ACP server.
  ignoreAgentCommandSetting: true,
  args: () => ['--profile', 'acp'],
  env: {},
  dialect: DSH_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('dsh')?.loginCommand ?? [],
  account: directoryAccountBinding('DSH_HOME', (homePath) => join(homePath, '.dsh')),
  installDirectories: () => [],
  modelDiscovery: {
    kind: 'session',
    listingNamesConfiguredModel: false
  },
  transcriptImport: null,
  sessionHistory: DSH_SESSION_HISTORY,
  keepsEverySession: true
}
