import { join } from 'node:path'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { CURSOR_ACP_DIALECT } from '../acp/acp-dialects/cursor-dialect'
import { readCursorModelCatalog } from '../acp/acp-dialects/cursor-model-catalog'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/agent-session-setup-commands'
import type { StructuredAgentSessionHistory } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// `--resume <id>` reads the terminal store; it cannot open a chat's ACP session.
const CURSOR_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['cursor'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: () => null
}

// The config folder holds Cursor's allowlist and sessions; its login lives elsewhere per platform.
function cursorConfigDirectory(homePath: string, env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME?.trim()
  return xdg ? join(xdg, 'cursor') : join(homePath, '.cursor')
}

export const CURSOR_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'cursor',
  command: 'cursor-agent',
  // No bypass flag; full access approves permission requests individually.
  args: () => ['--disable-auto-update', 'acp'],
  env: {},
  dialect: CURSOR_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('cursor')?.loginCommand ?? [],
  // No authMethod: `authenticate` while signed out opens a browser and waits.
  account: directoryAccountBinding('CURSOR_CONFIG_DIR', cursorConfigDirectory),
  // The install script's default prefix.
  installDirectories: ({ homePath }) => [join(homePath, '.local', 'bin')],
  // The build hash parses as a semver prerelease, so this is the day before the first verified ACP build.
  minimumVersions: ['2026.10.21'],
  modelDiscovery: {
    kind: 'initialize',
    read: (_initialized, connection) => readCursorModelCatalog(connection),
    // Each model's listed defaults are its own, not the model a new session starts on.
    listingNamesConfiguredModel: false
  },
  transcriptImport: null,
  sessionHistory: CURSOR_SESSION_HISTORY,
  // No session/close or delete: a naming task's session would stay in the user's Cursor history.
  keepsEverySession: true
}
