import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { DEVIN_ACP_DIALECT } from '../acp/acp-dialects/devin-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { deliverDevinInstructions } from '../acp/launch/acp-instructions'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// Chats and terminals share Devin's session store; `--resume` reopens a session by its id.
const DEVIN_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['devin'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: ['-c', '--continue'],
      markers: ['-r', '--resume']
    })
}

export const DEVIN_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'devin',
  command: 'devin',
  // A configured daemon would own the session and keep the environment of the chat that started it.
  args: () => ['acp', '--process-model', 'in-process'],
  env: {},
  dialect: DEVIN_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('devin')?.loginCommand ?? [],
  // `<root>/devin/cli` holds the sign-in and sessions; on Windows the CLI reads %APPDATA%, not XDG.
  account:
    process.platform === 'win32'
      ? directoryAccountBinding('APPDATA', (homePath) => join(homePath, 'AppData', 'Roaming'))
      : directoryAccountBinding('XDG_DATA_HOME', (homePath) => join(homePath, '.local', 'share')),
  // The installers' default locations.
  installDirectories: ({ env, homePath }) =>
    process.platform === 'win32'
      ? [join(env.LOCALAPPDATA?.trim() || join(homePath, 'AppData', 'Local'), 'devin\\cli\\bin')]
      : [join(homePath, '.local', 'bin')],
  // The release checked live with these modes, model select and `--process-model`.
  minimumVersions: ['3000.14.30821'],
  // Devin enforces its own modes. Its Ask is read-only, as close as it comes to asking before edits.
  permissionModeConfig: {
    values: { ask: 'ask', 'accept-edits': 'accept-edits', auto: 'smart', 'full-access': 'bypass' }
  },
  // Session discovery deletes its listing session.
  modelDiscovery: { kind: 'session', listingNamesConfiguredModel: false },
  botToolsOff: "Devin doesn't load the tools Orca passes to its chats",
  instructions: deliverDevinInstructions,
  instructionsInWorkspace: true,
  compaction: true,
  transcriptImport: null,
  sessionHistory: DEVIN_SESSION_HISTORY
}
