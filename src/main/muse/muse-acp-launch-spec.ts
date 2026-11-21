import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import type { AcpDialect } from '../acp/acp-dialects/acp-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import type { AcpInstructionsDelivery } from '../acp/launch/acp-instructions'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import type { StructuredAgentSessionHistory } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// Muse speaks plain ACP v1; nothing of its own needs interpreting yet.
const MUSE_ACP_DIALECT: AcpDialect = {}

// `muse resume <ref>` is a subcommand, not a flag; `--last` names no target.
const MUSE_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['muse'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) => {
    const at = args.indexOf('resume')
    if (at === -1) {
      return null
    }
    const target = args.slice(at + 1).find((token) => !token.startsWith('-'))
    return { target: target ?? null }
  }
}

// Host settings take JSON values, so the text travels as one JSON string on the launch line.
const deliverMuseInstructions: AcpInstructionsDelivery = async ({ text }) => ({
  args: ['-c', `run.system_prompt_append=${JSON.stringify(text)}`]
})

export const MUSE_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'muse',
  command: 'muse',
  // Trust matches the terminal launch, so the chat loads the folder's skills and rules too.
  args: () => ['acp', '--trust-workspace'],
  // The launcher's update, login and install steps would write to the stdout ACP owns.
  env: { MUSE_NO_AUTO_UPDATE: '1', MUSE_LOGIN: '0', MUSE_LAUNCHER_INSTALL: '0' },
  dialect: MUSE_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('muse')?.loginCommand ?? [],
  // Muse keeps its sign-in and settings under the XDG config home.
  account: directoryAccountBinding('XDG_CONFIG_HOME', (homePath) => join(homePath, '.config')),
  installDirectories: ({ homePath }) => [join(homePath, '.local', 'bin')],
  // First release checked against Orca's chat.
  minimumVersions: ['1.4.24'],
  // Muse enforces its own approval modes, chosen per session.
  permissionModeConfig: {
    values: { ask: 'promptUnmatched', 'full-access': 'allowAll' }
  },
  // Muse lists its models only inside a session.
  modelDiscovery: {
    kind: 'unavailable',
    reason: 'Muse lists its models only inside a session'
  },
  instructions: deliverMuseInstructions,
  compaction: true,
  transcriptImport: null,
  sessionHistory: MUSE_SESSION_HISTORY,
  // No session/delete: a naming task's session would land in the user's Muse history.
  keepsEverySession: true
}
