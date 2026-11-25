import type { AcpAccountBinding } from '../acp/launch/acp-account-binding'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { MCODE_DIALECT } from '../acp/acp-dialects/mcode-dialect'
import { readMcodeModelCatalog } from '../acp/acp-dialects/mcode-model-catalog'
import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { isLegacyAgentSessionAccountHome } from '../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { resolveMcodeDataDir } from '../../shared/agent-launch/environment/mcode-data-dir'

// Chats and terminals share mcode's session store and `mvs_*` ids.
const MCODE_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: [],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, { targetless: [], markers: ['--session'] })
}

/** mcode resolves MINIMAX_DATA_DIR, then its MAVIS_DATA_DIR alias, then ~/.minimax; pinning both
 *  keeps the TUI's sign-in and ACP sessions on one credential store. */
const MCODE_ACCOUNT: AcpAccountBinding = {
  pin: { accountHomeVariable: 'MINIMAX_DATA_DIR' },
  resolve: async ({ launchEnv }) => ({
    variable: 'MINIMAX_DATA_DIR',
    path: resolveMcodeDataDir({
      // Keep the cross-source priority: launch MINIMAX, saved MINIMAX, launch MAVIS, saved MAVIS.
      MINIMAX_DATA_DIR: launchEnv.MINIMAX_DATA_DIR?.trim() || process.env.MINIMAX_DATA_DIR,
      MAVIS_DATA_DIR: launchEnv.MAVIS_DATA_DIR?.trim() || process.env.MAVIS_DATA_DIR
    })
  }),
  environment: (home, env) => {
    if (!isLegacyAgentSessionAccountHome(home) || home.variable !== 'MINIMAX_DATA_DIR') {
      throw new Error('sessions of this agent pin MINIMAX_DATA_DIR')
    }
    return { ...env, MINIMAX_DATA_DIR: home.path, MAVIS_DATA_DIR: home.path }
  }
}

export const MCODE_LAUNCH_SPEC = {
  agent: 'mcode',
  command: 'mcode',
  args: () => ['acp'],
  env: {},
  dialect: MCODE_DIALECT,
  loginCommand: agentSessionSetupFor('mcode')?.loginCommand ?? [],
  account: MCODE_ACCOUNT,
  installDirectories: () => [],
  compaction: true,
  modelDiscovery: {
    kind: 'initialize',
    read: readMcodeModelCatalog,
    listingNamesConfiguredModel: true,
    homeConfigFiles: ['config.yaml']
  },
  transcriptImport: null,
  sessionHistory: MCODE_SESSION_HISTORY,
  resumePreference: 'resume'
} satisfies AcpLaunchSpec
