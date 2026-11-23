import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { HERMES_ACP_DIALECT } from '../acp/acp-dialects/hermes-dialect'
import { directoryAccountBinding, type AcpAccountBinding } from '../acp/launch/acp-account-binding'
import { isLegacyAgentSessionAccountHome } from '../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import {
  getHermesHome,
  resolveDefaultHermesHome,
  resolveHermesActiveProfileHome
} from './hermes-default-home'
import { HERMES_TRANSCRIPT_IMPORT } from './hermes-transcript-import'
import { deliverHermesInstructions } from '../acp/launch/acp-instructions'

// Chats and terminals share the profile's session store; `--resume` also takes a session title.
const HERMES_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['hermes'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: ['-c', '--continue'],
      markers: ['-r', '--resume']
    })
}

const hermesHome = (homePath: string, env: NodeJS.ProcessEnv) =>
  resolveDefaultHermesHome({ homeDir: homePath, env })

// Pin the profile Hermes runs now, so a later `hermes profile use` cannot move a named profile's
// chats to another store. A chat on the default profile still follows it, as Hermes itself does.
function hermesAccountBinding(): AcpAccountBinding {
  const root = directoryAccountBinding('HERMES_HOME', hermesHome)
  return {
    ...root,
    resolve: async (input) => {
      const home = await root.resolve(input)
      return isLegacyAgentSessionAccountHome(home)
        ? { ...home, path: await resolveHermesActiveProfileHome(home.path) }
        : home
    }
  }
}

export const HERMES_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'hermes',
  command: 'hermes',
  // No bypass flag: Hermes freezes launch flags into the session, so full access answers requests.
  args: () => ['acp'],
  env: {},
  // Bare `--version` checks for updates over the network first.
  versionArgs: ['acp'],
  dialect: HERMES_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('hermes')?.loginCommand ?? [],
  account: hermesAccountBinding(),
  // The installers' command folders: ~/.local/bin, and the home's own bin on Windows.
  installDirectories: ({ env, homePath }) => [
    join(homePath, '.local', 'bin'),
    join(getHermesHome(env, homePath), 'bin')
  ],
  // 0.23.0 restored ACP after the gateway rewrite broke it.
  minimumVersions: ['0.23.0'],
  // Its modes only gate edits; command approvals follow the profile, so Orca answers them in full access.
  permissionModeConfig: {
    values: { ask: 'ask', 'accept-edits': 'workspace_session', 'full-access': 'session' },
    fullAccessAnswersRequests: true
  },
  // Hermes cannot delete sessions, so a listing session would stay in the profile's store.
  modelDiscovery: {
    kind: 'unavailable',
    reason: 'Hermes lists its models only inside a session it cannot delete'
  },
  instructions: deliverHermesInstructions,
  instructionsInWorkspace: true,
  compaction: true,
  compactionInstructions: true,
  transcriptImport: HERMES_TRANSCRIPT_IMPORT,
  sessionHistory: HERMES_SESSION_HISTORY,
  keepsEverySession: true,
  // Tools run in the profile's gateway, which outlives the chat that started it and serves the rest.
  sharedToolProcess: true
}
