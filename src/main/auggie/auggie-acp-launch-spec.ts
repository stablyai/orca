import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { AUGGIE_ACP_DIALECT } from '../acp/acp-dialects/auggie-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { deliverAppendSystemPromptInstructions } from '../acp/launch/acp-instructions'
import { loadAuggieSkillRoots } from '../acp/launch/acp-skill-roots'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import type { StructuredAgentSessionHistory } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// Session History doesn't list Auggie's sessions, so no history row or terminal resume maps to a chat.
const AUGGIE_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: [],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: () => null
}

export const AUGGIE_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'aug',
  command: 'auggie',
  // Auggie asks no approvals unless the user's own tool permissions say so.
  args: () => ['--acp'],
  env: {},
  dialect: AUGGIE_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('aug')?.loginCommand ?? [],
  // The whole config root: sign-in, settings, MCP servers and sessions.
  account: directoryAccountBinding('AUGMENT_CACHE_DIR', (homePath) => join(homePath, '.augment')),
  installDirectories: () => [],
  // 1.2.0 is the first release on the Pi rewrite; 0.x fails `session/new`.
  minimumVersions: ['1.2.0'],
  // Models follow the Augment account; Auggie cannot delete sessions, so the listing one is kept
  // in a private folder. It reports no commands, so no chat-folder scan would ever finish.
  modelDiscovery: {
    kind: 'session',
    listingNamesConfiguredModel: false,
    inPrivateFolder: true,
    sessionFolderArgs: (folder) => ['--session-dir', folder]
  },
  skillRoots: loadAuggieSkillRoots,
  // Its ACP server ignores `session/new` mcpServers (1.2.2).
  botToolsOff: "Auggie doesn't load the tools Orca passes to its chats",
  instructions: deliverAppendSystemPromptInstructions,
  transcriptImport: null,
  sessionHistory: AUGGIE_SESSION_HISTORY,
  // No session/delete: a naming task's session would land in the user's Auggie history.
  keepsEverySession: true
}
