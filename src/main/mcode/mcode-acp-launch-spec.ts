import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { MCODE_DIALECT } from '../acp/acp-dialects/mcode-dialect'
import { readMcodeModelCatalog } from '../acp/acp-dialects/mcode-model-catalog'
import type { StructuredAgentSessionHistory } from '../native-chat/structured-agent-cli-conversations'
import { agentSessionSignInFor } from '../../shared/agent-session/lifecycle/agent-session-sign-in'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'

const MCODE_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: [],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: () => null
}

export const MCODE_LAUNCH_SPEC = {
  agent: 'mcode',
  command: 'mcode',
  args: () => ['acp'],
  env: {},
  dialect: MCODE_DIALECT,
  loginCommand: agentSessionSignInFor('mcode')?.loginCommand ?? [],
  account: directoryAccountBinding('MINIMAX_DATA_DIR', (homePath) => join(homePath, '.minimax')),
  installDirectories: () => [],
  modelDiscovery: {
    kind: 'initialize',
    read: readMcodeModelCatalog,
    listingNamesConfiguredModel: true
  },
  transcriptImport: null,
  sessionHistory: MCODE_SESSION_HISTORY,
  resumePreference: 'resume'
} satisfies AcpLaunchSpec
