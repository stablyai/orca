import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { DROID_ACP_DIALECT } from '../acp/acp-dialects/droid-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { deliverDroidInstructions } from '../acp/launch/acp-instructions'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// Chats and terminals share Droid's session store; `droid resume <id>` is `--resume <id>`.
const DROID_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['droid'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args[0] === 'resume' ? ['--resume', ...args.slice(1)] : args, {
      targetless: ['--last'],
      markers: ['-r', '--resume']
    })
}

export const DROID_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'droid',
  command: 'droid',
  // No bypass flag; full access sets Droid's own Auto (High) level.
  args: () => ['exec', '--output-format', 'acp'],
  // As the ACP registry launches it, so an update never replaces the binary under a running chat.
  env: { DROID_DISABLE_AUTO_UPDATE: 'true', FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false' },
  dialect: DROID_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('droid')?.loginCommand ?? [],
  // Droid keeps its sign-in, settings and sessions in `.factory` under this folder.
  account: directoryAccountBinding('FACTORY_HOME_OVERRIDE', (homePath) => homePath),
  // The install script's default prefix.
  installDirectories: ({ homePath }) => [join(homePath, '.local', 'bin')],
  // 0.236.0 first reports its autonomy level as a config option Orca can set and confirm.
  minimumVersions: ['0.236.0'],
  // Droid enforces its autonomy levels and starts on its own default (Auto (Medium)) until one is set.
  permissionModeConfig: {
    values: { ask: 'normal', auto: 'auto-medium', 'full-access': 'auto-high' }
  },
  // Only a session lists the account's models, and Droid cannot delete a listing session.
  modelDiscovery: {
    kind: 'unavailable',
    reason: 'Droid lists its models only inside a session it cannot delete'
  },
  instructions: deliverDroidInstructions,
  transcriptImport: null,
  sessionHistory: DROID_SESSION_HISTORY,
  // No session/delete: a naming task's session would land in the user's Droid history.
  keepsEverySession: true
}
