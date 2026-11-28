import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { KIMCHI_ACP_DIALECT } from '../acp/acp-dialects/kimchi-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { deliverKimchiInstructions } from '../acp/launch/acp-instructions'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

const KIMCHI_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: [],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: ['-c', '--continue'],
      markers: ['-r', '--resume', '--session']
    })
}

export const KIMCHI_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'kimchi',
  command: 'kimchi',
  args: ({ preTrustWorkspace }) => [
    '--mode',
    'acp',
    '--no-auto-update',
    ...(preTrustWorkspace ? ['--approve'] : [])
  ],
  env: {},
  dialect: KIMCHI_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('kimchi')?.loginCommand ?? [],
  account: directoryAccountBinding(
    'KIMCHI_CODING_AGENT_DIR',
    (homePath) => join(homePath, '.config', 'kimchi', 'harness'),
    { allowOverride: false }
  ),
  installDirectories: ({ homePath }) => [join(homePath, '.local', 'bin')],
  minimumVersions: ['1.41.1'],
  permissionModeConfig: {
    values: { ask: 'default', auto: 'auto', 'full-access': 'yolo' }
  },
  modelDiscovery: { kind: 'session', listingNamesConfiguredModel: false },
  instructions: deliverKimchiInstructions,
  compaction: true,
  compactionInstructions: true,
  transcriptImport: null,
  sessionHistory: KIMCHI_SESSION_HISTORY
}
