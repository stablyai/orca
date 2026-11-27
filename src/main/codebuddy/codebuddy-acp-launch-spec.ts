import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { CODEBUDDY_ACP_DIALECT } from '../acp/acp-dialects/codebuddy-dialect'
import { directoryAccountBinding, type AcpAccountBinding } from '../acp/launch/acp-account-binding'
import { deliverCodeBuddyInstructions } from '../acp/launch/acp-instructions'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import type { StructuredAgentSessionHistory } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { parseClaudeResumeArgs } from '../claude/claude-cli-conversations'

// Chats and terminals share CodeBuddy's session store, which Session History lists. Its resume and
// fork flags are Claude Code's.
const CODEBUDDY_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['codebuddy'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: parseClaudeResumeArgs
}

const configDirectory = directoryAccountBinding('CODEBUDDY_CONFIG_DIR', (homePath) =>
  join(homePath, '.codebuddy')
)

// Setting the variable, even to its default, moves CodeBuddy's own MCP servers file from
// ~/.codebuddy.json into the folder, so a chat on the default folder leaves it unset.
const CODEBUDDY_ACCOUNT: AcpAccountBinding = {
  ...configDirectory,
  environment: (home, env) => {
    const pinned = configDirectory.environment(home, env)
    const defaultFolder = join(homedir(), '.codebuddy')
    return env.CODEBUDDY_CONFIG_DIR === undefined && pinned.CODEBUDDY_CONFIG_DIR === defaultFolder
      ? env
      : pinned
  }
}

export const CODEBUDDY_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'codebuddy',
  command: 'codebuddy',
  args: () => ['--acp'],
  env: {},
  dialect: CODEBUDDY_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('codebuddy')?.loginCommand ?? [],
  account: CODEBUDDY_ACCOUNT,
  // The native installer's default location.
  installDirectories: ({ homePath }) => [join(homePath, '.local', 'bin')],
  // 2.121.0 added the Full Access mode Orca's full access selects.
  minimumVersions: ['2.121.0'],
  // Its Bypass Permissions mode still asks before risky commands; Full Access asks nothing.
  permissionModeConfig: {
    values: {
      ask: 'default',
      'accept-edits': 'acceptEdits',
      auto: 'auto',
      'full-access': 'fullAccess'
    }
  },
  // Only a session lists models, and CodeBuddy cannot delete a listing session.
  modelDiscovery: {
    kind: 'unavailable',
    reason: 'CodeBuddy lists its models only inside a session it cannot delete'
  },
  instructions: deliverCodeBuddyInstructions,
  instructionsInWorkspace: true,
  compaction: true,
  compactionInstructions: true,
  transcriptImport: null,
  sessionHistory: CODEBUDDY_SESSION_HISTORY,
  // No session/delete: a naming task's session would land in the user's CodeBuddy history.
  keepsEverySession: true
}
