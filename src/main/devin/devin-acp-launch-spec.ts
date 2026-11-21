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

// Chats and terminals share Devin's session store, whose transcript files are named by session id;
// `--resume` takes a session id or a prefix of one.
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
  // Inherited overrides would run every chat under a mode and model the pickers never showed.
  scrubEnvironment: (env) => {
    delete env.DEVIN_PERMISSION_MODE
    delete env.DEVIN_MODEL
    return ['DEVIN_PERMISSION_MODE', 'DEVIN_MODEL']
  },
  dialect: DEVIN_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('devin')?.loginCommand ?? [],
  // Devin keeps its sign-in, its sessions and its transcripts under `<XDG_DATA_HOME>/devin`.
  account: directoryAccountBinding('XDG_DATA_HOME', (homePath) =>
    join(homePath, '.local', 'share')
  ),
  // The install script's default location.
  installDirectories: ({ homePath }) => [join(homePath, '.local', 'bin')],
  // First release verified to serve ACP with the mode and model selects this spec sets.
  minimumVersions: ['3000.14.30821'],
  // Devin enforces its own modes; one select carries both them and Plan, so Orca's Plan toggle stays
  // off rather than write a mode the permission picker is showing.
  permissionModeConfig: {
    values: {
      ask: 'ask',
      'accept-edits': 'accept-edits',
      auto: 'smart',
      'full-access': 'bypass'
    }
  },
  // The whole catalog is a session select, and Devin deletes its listing session.
  modelDiscovery: { kind: 'session', listingNamesConfiguredModel: false },
  instructions: deliverDevinInstructions,
  instructionsInWorkspace: true,
  compaction: true,
  transcriptImport: null,
  sessionHistory: DEVIN_SESSION_HISTORY
}
