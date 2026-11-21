import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { DEVIN_ACP_DIALECT } from '../acp/acp-dialects/devin-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { deliverDevinInstructions } from '../acp/launch/acp-instructions'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import {
  resumeInvocationFromOptions,
  sessionFileResumeTargetMatches,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// Chats and terminals share Devin's session store; `--resume` takes a session id or a prefix.
const DEVIN_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['devin'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: ['-c', '--continue'],
      markers: ['-r', '--resume']
    }),
  resumeTargetMatches: sessionFileResumeTargetMatches
}

export const DEVIN_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'devin',
  command: 'devin',
  args: () => ['acp'],
  env: {},
  // Inherited launch overrides would run every chat under a mode and model the picker never set.
  scrubEnvironment: (env) => {
    delete env.DEVIN_PERMISSION_MODE
    delete env.DEVIN_MODEL
    return ['DEVIN_PERMISSION_MODE', 'DEVIN_MODEL']
  },
  dialect: DEVIN_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('devin')?.loginCommand ?? [],
  // Devin follows XDG on POSIX (~/.config/devin) and %APPDATA% on Windows.
  account: directoryAccountBinding('XDG_CONFIG_HOME', (homePath) => join(homePath, '.config')),
  // The install script's command folder.
  installDirectories: ({ homePath }) => [join(homePath, '.local', 'bin')],
  // Session config controls (model, effort, speed selects) arrived in 3000.11.1.
  minimumVersions: ['3000.11.1'],
  // One mode select carries permissions and Plan; Orca's Plan toggle stays off rather than
  // displace the permission mode the picker shows.
  permissionModeConfig: {
    values: {
      ask: 'ask',
      'accept-edits': 'accept-edits',
      auto: 'smart',
      'full-access': 'bypass'
    }
  },
  // The full catalog is a session config select; Devin deletes sessions, so listing leaves none.
  modelDiscovery: { kind: 'session', listingNamesConfiguredModel: false },
  instructions: deliverDevinInstructions,
  instructionsInWorkspace: true,
  compaction: true,
  transcriptImport: null,
  sessionHistory: DEVIN_SESSION_HISTORY
}
