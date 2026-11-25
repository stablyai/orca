import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { GENERIC_ACP_DIALECT } from '../acp/acp-dialects/acp-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { deliverDshInstructions } from '../acp/launch/acp-instructions'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import type { StructuredAgentSessionHistory } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// DSH lists its own sessions only inside its UI, and its ACP server has no session/delete, so no
// history row or terminal resume maps to a chat.
const DSH_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: [],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: () => null
}

export const DSH_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'dsh',
  command: 'dsh',
  // Our terminal agent launches the community `dsh-tui`; the chat server is the CLI's own `acp`
  // profile, so a Command setting meant for the TUI must not replace it.
  ignoreAgentCommandSetting: true,
  args: () => ['--profile', 'acp'],
  env: {},
  dialect: GENERIC_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('dsh')?.loginCommand ?? [],
  // One home holds this CLI's profiles, credentials and sessions; it defaults to ~/.dsh and moves
  // wholesale with DSH_HOME, so the account is pinned to it.
  account: directoryAccountBinding('DSH_HOME', (homePath) => join(homePath, '.dsh')),
  installDirectories: () => [],
  // `acp` is a shipped profile template and the CLI reports an incompatible hook row without
  // failing, so the first release whose ACP server answers `session/new` is the floor.
  minimumVersions: ['0.2.0'],
  // DSH cannot delete the session a listing opens, so it lists in a private folder the chat never
  // touches.
  modelDiscovery: {
    kind: 'session',
    listingNamesConfiguredModel: false,
    inPrivateFolder: true
  },
  instructions: deliverDshInstructions,
  transcriptImport: null,
  sessionHistory: DSH_SESSION_HISTORY,
  // No session/delete: a naming task's session would land in the user's own DSH history.
  keepsEverySession: true
}
