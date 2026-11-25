import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import { GENERIC_ACP_DIALECT } from '../acp/acp-dialects/acp-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import {
  defaultQwenWorkMacProfile,
  findQwenWorkDesktopEngine,
  QWENWORK_DESKTOP_PROFILE
} from './qwenwork-desktop-engine'

export const QWENWORK_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'qwenwork',
  command: 'QwenWork',
  bundledProgram: async (env) => {
    const program = await findQwenWorkDesktopEngine(env)
    if (!program) {
      throw new AgentSessionPreSpawnError(
        'No compatible QwenWork desktop engine was found on this host.',
        { reason: 'runtimeNotInstalled' }
      )
    }
    return program
  },
  args: () => [],
  env: { ELECTRON_RUN_AS_NODE: '1' },
  dialect: GENERIC_ACP_DIALECT,
  loginCommand: [],
  authMethod: ({ advertised }) => advertised.find((method) => method === 'qwenwork-login'),
  account:
    process.platform === 'darwin'
      ? directoryAccountBinding(QWENWORK_DESKTOP_PROFILE, defaultQwenWorkMacProfile)
      : directoryAccountBinding('USERPROFILE', (home) => home),
  installDirectories: () => [],
  modelDiscovery: { kind: 'unavailable', reason: 'QwenWork desktop manages its session models' },
  keepsEverySession: true,
  transcriptImport: null,
  sessionHistory: {
    rowAgents: [],
    rowSessionId: (link) => link.handle.nativeId,
    parseResumeArgs: () => null
  }
}
