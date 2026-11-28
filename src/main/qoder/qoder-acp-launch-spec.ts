import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { QODER_ACP_DIALECT } from '../acp/acp-dialects/qoder-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { deliverAppendSystemPromptFileInstructions } from '../acp/launch/acp-instructions'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// Chats and terminals share Qoder's session store, which Session History lists.
const QODER_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['qoder'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: ['-c', '--continue'],
      markers: ['-r', '--resume']
    })
}

export const QODER_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'qoder',
  command: 'qodercli',
  args: () => ['--acp'],
  env: {},
  dialect: QODER_ACP_DIALECT,
  // No authMethod: its only one opens a browser; a saved login or QODER_PERSONAL_ACCESS_TOKEN
  // restores at initialize.
  loginCommand: agentSessionSetupFor('qoder')?.loginCommand ?? [],
  // The whole config root: sign-in, settings and sessions.
  account: directoryAccountBinding('QODER_CONFIG_DIR', (homePath) => join(homePath, '.qoder')),
  // The native installer links ~/.local/bin on Unix and copies the binary into its folder on Windows.
  installDirectories: ({ homePath }) =>
    process.platform === 'win32'
      ? [join(homePath, '.qoder', 'bin', 'qodercli')]
      : [join(homePath, '.local', 'bin')],
  // 1.1.81 fixed switching an ACP session to yolo, which Full access sets at every start.
  minimumVersions: ['1.1.81'],
  // Qoder enforces its own modes, and a new session starts in the user's default, so each start sets one.
  permissionModeConfig: {
    values: { ask: 'default', 'accept-edits': 'acceptEdits', auto: 'auto', 'full-access': 'yolo' }
  },
  // Models follow the account; session discovery deletes its listing session.
  modelDiscovery: { kind: 'session', listingNamesConfiguredModel: false, inPrivateFolder: true },
  instructions: deliverAppendSystemPromptFileInstructions,
  compaction: true,
  compactionInstructions: true,
  transcriptImport: null,
  sessionHistory: QODER_SESSION_HISTORY
}
