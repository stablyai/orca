import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { GENERIC_ACP_DIALECT } from '../acp/acp-dialects/acp-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'

export const BQAGENT_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'bqagent',
  command: 'bqagent',
  args: () => ['--acp'],
  env: {},
  dialect: GENERIC_ACP_DIALECT,
  loginCommand: [],
  // Go's os.UserHomeDir selects the home containing .agent on the execution host.
  account: directoryAccountBinding(
    process.platform === 'win32' ? 'USERPROFILE' : 'HOME',
    (home) => home
  ),
  installDirectories: () => [],
  autonomousTools: true,
  imagePrompts: false,
  keepsEverySession: true,
  modelDiscovery: {
    kind: 'unavailable',
    reason: 'bqagent reports models in each chat and persists every session it creates.'
  },
  transcriptImport: null,
  sessionHistory: {
    rowAgents: [],
    rowSessionId: (link) => link.handle.nativeId,
    parseResumeArgs: () => null
  }
}
