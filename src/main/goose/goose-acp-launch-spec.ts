import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { GOOSE_ACP_DIALECT } from '../acp/acp-dialects/goose-dialect'
import { deliverGooseInstructions } from '../acp/launch/acp-instructions'
import type { AcpAccountBinding } from '../acp/launch/acp-account-binding'
import { isLegacyAgentSessionAccountHome } from '../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { resolveStructuredEnvAccountHomePath } from '../runtime/agent-session/environment/structured-agent-account-home'
import type { StructuredAgentSessionHistory } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// Goose has no Session History rows, and `goose session` lists only its terminal sessions.
const GOOSE_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: [],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: () => null
}

// GOOSE_PATH_ROOT moves config, sessions and state together; without it they sit in per-platform
// folders no one variable names, so a chat runs on whatever store its inherited environment selects.
const GOOSE_ACCOUNT: AcpAccountBinding = {
  pin: { accountHomeVariable: 'GOOSE_PATH_ROOT' },
  resolve: async ({ launchEnv }) => ({
    variable: 'GOOSE_PATH_ROOT',
    path: resolveStructuredEnvAccountHomePath({
      launchEnv,
      variable: 'GOOSE_PATH_ROOT',
      defaultPath: (homePath) => join(homePath, '.config', 'goose')
    })
  }),
  environment: (home, env) => {
    if (!isLegacyAgentSessionAccountHome(home) || home.variable !== 'GOOSE_PATH_ROOT') {
      throw new Error('sessions of this agent pin GOOSE_PATH_ROOT')
    }
    return env
  }
}

export const GOOSE_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'goose',
  command: 'goose',
  args: () => ['acp'],
  env: {},
  dialect: GOOSE_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('goose')?.loginCommand ?? [],
  account: GOOSE_ACCOUNT,
  // The install scripts' default folder on every platform.
  installDirectories: ({ homePath }) => [join(homePath, '.local', 'bin')],
  // The oldest release checked to report its modes over ACP, so Ask is enforced; 1.27.1 reported none.
  minimumVersions: ['1.42.0'],
  // Goose enforces its modes, and its configured GOOSE_MODE (auto by default) applies until one is set.
  permissionModeConfig: {
    values: { ask: 'approve', auto: 'smart_approve', 'full-access': 'auto' }
  },
  // Session discovery deletes its listing session.
  modelDiscovery: { kind: 'session', listingNamesConfiguredModel: false },
  instructions: deliverGooseInstructions,
  instructionsInWorkspace: true,
  compaction: true,
  transcriptImport: null,
  sessionHistory: GOOSE_SESSION_HISTORY
}
