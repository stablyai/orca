// Cursor chats run the host's `cursor-agent acp` against the login already on that computer.

import { join } from 'node:path'
import { homedir } from 'node:os'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import type { AcpDialect } from '../acp/acp-dialects/acp-dialect'
import type { AgentSessionModelOption } from '../../shared/agent-session/agent-session-wire'
import { groupCursorCliModels } from '../../shared/cursor-acp-model-label'
import { parseCursorModels } from '../../shared/source-control/ai/generation/commit-message-model-parsers'
import type { StructuredAgentSessionHistory } from '../native-chat/structured-agent-cli-conversations'
import {
  isLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session/lifecycle/agent-session-account-home'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/agent-session-setup-commands'

// The build hash parses as a semver prerelease, so this is the day before the first verified ACP build.
const CURSOR_ACP_MINIMUM_VERSION = '2026.10.21'
// cursor-agent reads ~/.cursor from the home directory and has no config-dir variable.
const CURSOR_ACCOUNT_HOME_VARIABLE = 'ORCA_CURSOR_CONFIG_DIR'
const CURSOR_CONFIG_FOLDER = '.cursor'

export function cursorHostAccountHome(homePath: string): AgentSessionAccountHome {
  return { variable: CURSOR_ACCOUNT_HOME_VARIABLE, path: join(homePath, CURSOR_CONFIG_FOLDER) }
}

/** Chats pin the host's ~/.cursor. The variable is Orca's record key and is never given to the CLI. */
export function isCursorHostAccountHome(home: AgentSessionAccountHome): boolean {
  return (
    isLegacyAgentSessionAccountHome(home) &&
    home.variable === CURSOR_ACCOUNT_HOME_VARIABLE &&
    home.path.split(/[\\/]+/).findLast(Boolean) === CURSOR_CONFIG_FOLDER
  )
}

// `cursor-agent models` is available before a chat exists. Its names are the ones the CLI shows.
function parseCursorAgentModels(stdout: string): AgentSessionModelOption[] {
  return groupCursorCliModels(parseCursorModels(stdout))
}

// Ask Cursor for a model plus its effort and fast parameters, instead of one selector per variant.
const CURSOR_ACP_DIALECT: AcpDialect = {
  clientCapabilities: { _meta: { parameterizedModelPicker: true } },
  fastConfigId: 'fast'
}

// Terminal resumes use conversation ids. ACP sessions live in a separate store and cannot adopt them.
const CURSOR_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['cursor'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: () => null
}

export const CURSOR_LAUNCH_SPEC = {
  agent: 'cursor',
  command: 'cursor-agent',
  args: ({ fullAccess }) => ['--disable-auto-update', ...(fullAccess ? ['--yolo'] : []), 'acp'],
  env: {},
  scrubEnvironment: () => [CURSOR_ACCOUNT_HOME_VARIABLE],
  dialect: CURSOR_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('cursor')?.loginCommand ?? [],
  authMethod: ({ advertised }) =>
    advertised.includes('cursor_login') ? 'cursor_login' : undefined,
  account: {
    pin: { accountHomeVariable: CURSOR_ACCOUNT_HOME_VARIABLE },
    resolve: async ({ launchEnv }) =>
      cursorHostAccountHome(launchEnv.HOME ?? launchEnv.USERPROFILE ?? homedir()),
    environment: (home, env) => {
      if (!isCursorHostAccountHome(home)) {
        throw new Error("this chat uses the host's Cursor login")
      }
      const next = { ...env }
      delete next[CURSOR_ACCOUNT_HOME_VARIABLE]
      return next
    }
  },
  installDirectories: ({ homePath }) => [join(homePath, '.local', 'bin')],
  minimumVersions: [CURSOR_ACP_MINIMUM_VERSION],
  modelDiscovery: {
    kind: 'command',
    args: ['models'],
    parse: parseCursorAgentModels,
    // The CLI default is not the model a new ACP session actually starts on.
    listingNamesConfiguredModel: false
  },
  transcriptImport: null,
  sessionHistory: CURSOR_SESSION_HISTORY,
  // session/close does not exist, so a naming chat would stay in the user's Cursor history.
  keepsEverySession: true
} satisfies AcpLaunchSpec
