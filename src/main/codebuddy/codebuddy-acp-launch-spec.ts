import { join, win32 } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { GENERIC_ACP_DIALECT } from '../acp/acp-dialects/acp-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// Chats and terminals share CodeBuddy's session store; --resume takes the session id.
const CODEBUDDY_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['codebuddy'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: ['-c', '--continue'],
      // --session-id names a new session, not a session to resume.
      markers: ['-r', '--resume']
    })
}

export const CODEBUDDY_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'codebuddy',
  command: 'codebuddy',
  args: () => ['--acp'],
  env: {},
  dialect: GENERIC_ACP_DIALECT,
  // CodeBuddy signs in through its TUI; there is no separate login subcommand.
  loginCommand: [],
  account: directoryAccountBinding('CODEBUDDY_CONFIG_DIR', (homePath) =>
    join(homePath, '.codebuddy')
  ),
  installDirectories: ({ env, homePath }) => {
    if (process.platform !== 'win32') {
      return []
    }
    // The Windows installer writes here; a PATH refreshed before install misses it.
    const localAppData = env.LOCALAPPDATA ?? win32.join(homePath, 'AppData', 'Local')
    return [win32.join(localAppData, 'codebuddy', 'bin')]
  },
  // ACP first ships in 2.185.0; earlier releases have no --acp.
  minimumVersions: ['2.185.0'],
  // CodeBuddy lists the models a session can use, not a standalone catalog, and cannot delete
  // the listing session, so the chat reads the model option from its own session instead.
  modelDiscovery: {
    kind: 'unavailable',
    reason: 'CodeBuddy lists models only inside a session'
  },
  permissionModeConfig: {
    values: {
      ask: 'default',
      'accept-edits': 'acceptEdits',
      auto: 'auto',
      'full-access': 'fullAccess'
    }
  },
  transcriptImport: null,
  sessionHistory: CODEBUDDY_SESSION_HISTORY,
  // No session/delete: a naming task's session would land in the user's history.
  keepsEverySession: true
}
