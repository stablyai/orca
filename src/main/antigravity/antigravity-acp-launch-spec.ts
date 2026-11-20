// Antigravity chats run `agy acp`: on agy's own home and login, or on Orca's chat home, where Orca
// supplies a Gemini API key or gcloud credentials and the chats Orca's retired server started live.

import { join, win32 } from 'node:path'
import { homedir } from 'node:os'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { ANTIGRAVITY_ACP_DIALECT } from '../acp/acp-dialects/antigravity-dialect'
import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { ANTIGRAVITY_TRANSCRIPT_IMPORT } from './antigravity-transcript-import'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { deliverAntigravityInstructions } from '../acp/launch/acp-instructions'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import { isLegacyAgentSessionAccountHome } from '../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { ANTIGRAVITY_LAUNCH_GATE, antigravityChatAccount } from './antigravity-chat-account'
import { scrubAntigravityAcpEnvironment } from './antigravity-acp-environment-sanitizer'
import { discardAntigravityListingSession } from './antigravity-listing-session'
import { parseAgyModelListing } from './antigravity-model-listing'
import { antigravityAgySignIn, antigravityChatUsesOrcaHome } from './antigravity-chat-route'
import {
  AGY_SKIP_PERMISSIONS_FLAG,
  ANTIGRAVITY_HOST_ACP_MINIMUM_VERSION,
  antigravityHostAccountHome,
  isAntigravityHostAccountHome
} from './antigravity-host-acp'

// Chats and terminals share agy's conversation store when a chat runs on agy's home. A bare `-c`
// is not refused: chats on Orca's home live elsewhere, so it would block agy for every Chat user.
const ANTIGRAVITY_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['antigravity'],
  rowSessionId: (link) => link.handle.nativeId,
  // agy parses Go flags, so a single dash and `--flag=value` spell the same option.
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, {
      targetless: [],
      markers: ['--conversation', '-conversation']
    })
}

// Alternate-case updater flags on Windows would shadow the configured uppercase entry.
function scrubAgyShadowedSettings(env: Record<string, string>, inherited: NodeJS.ProcessEnv) {
  if (process.platform !== 'win32') {
    return []
  }
  const removed = [...new Set([...Object.keys(env), ...Object.keys(inherited)])].filter(
    (key) => key.toUpperCase() === 'AGY_CLI_DISABLE_AUTO_UPDATE' && key !== key.toUpperCase()
  )
  for (const key of removed) {
    delete env[key]
  }
  return removed
}

function agyInstallDirectories({
  env,
  homePath
}: {
  env: Readonly<Record<string, string>>
  homePath: string
}): string[] {
  if (process.platform !== 'win32') {
    return [join(homePath, '.local', 'bin')]
  }
  const localAppData = Object.entries(env)
    .find(([key]) => key.toUpperCase() === 'LOCALAPPDATA')?.[1]
    ?.trim()
  return [
    ...new Set([
      ...(localAppData && win32.isAbsolute(localAppData) ? [join(localAppData, 'agy', 'bin')] : []),
      join(homePath, 'AppData', 'Local', 'agy', 'bin'),
      join(homePath, '.local', 'bin')
    ])
  ]
}

// `agy acp` on agy's own home: its own sign-in, settings and history; Orca neither signs it in nor
// out. Its own settings may pick an API-key provider, which reads GEMINI_API_KEY, so keys pass.
const AGY_HOME_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'antigravity',
  command: 'agy',
  ignoreAgentCommandSetting: true,
  // Off, Orca's agy runs no chat: chats run the user's own, and on a host without one they get
  // launch's cliMissing refusal.
  managedCopyAllowed: (settings) => settings.antigravityManagedAgyEnabled !== false,
  args: ({ fullAccess }) => ['acp', ...(fullAccess ? [AGY_SKIP_PERMISSIONS_FLAG] : [])],
  // Match terminal and quota launches: a background updater steals focus on Windows (#27390)
  // and can replace agy mid-probe.
  env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
  scrubEnvironment: scrubAgyShadowedSettings,
  dialect: ANTIGRAVITY_ACP_DIALECT,
  loginCommand: agentSessionSetupFor('antigravity')?.loginCommand ?? [],
  account: {
    pin: antigravityChatAccount.pin,
    resolve: async ({ launchEnv }) =>
      antigravityHostAccountHome(launchEnv.HOME ?? launchEnv.USERPROFILE ?? homedir()),
    environment: (home, env) => {
      if (!isAntigravityHostAccountHome(home)) {
        throw new Error("this chat runs on agy's own home")
      }
      return env
    }
  },
  minimumVersions: [ANTIGRAVITY_HOST_ACP_MINIMUM_VERSION],
  installDirectories: agyInstallDirectories,
  // agy has no full-access mode, so its launch flag grants it; plan approvals still reach the chat.
  permissionModeConfig: {
    values: { ask: 'default', 'accept-edits': 'accept-edits', 'full-access': 'default' },
    fullAccessAtLaunch: true
  },
  // `agy models` lists without opening a session.
  modelDiscovery: {
    kind: 'command',
    args: ['models'],
    parse: parseAgyModelListing,
    listingNamesConfiguredModel: false
  },
  instructions: deliverAntigravityInstructions,
  transcriptImport: ANTIGRAVITY_TRANSCRIPT_IMPORT,
  sessionHistory: ANTIGRAVITY_SESSION_HISTORY,
  // `session/load` replays the whole conversation, which the chat already holds.
  resumePreference: 'resume',
  launchGate: ANTIGRAVITY_LAUNCH_GATE,
  // agy can't delete sessions, so naming tasks would stay in its history.
  keepsEverySession: true
}

// `agy acp` on Orca's chat home, isolated from the person's own agy: the saved key or gcloud reach
// it through its settings file and environment, and the retired server's chats resume in place.
const ORCA_HOME_LAUNCH_SPEC = {
  ...AGY_HOME_LAUNCH_SPEC,
  accountArgs: (home) =>
    isLegacyAgentSessionAccountHome(home)
      ? ['--gemini-dir', home.path, '--app-data-dir', ANTIGRAVITY_ACP_HOME]
      : [],
  readsAntigravityChatAuth: true,
  scrubEnvironment: scrubAntigravityAcpEnvironment,
  account: antigravityChatAccount,
  // `agy models` reads only agy's own home, so this home lists in a session Orca then removes.
  modelDiscovery: {
    kind: 'session',
    listingNamesConfiguredModel: false,
    inPrivateFolder: true,
    discardSession: discardAntigravityListingSession
  }
} satisfies AcpLaunchSpec

export const ANTIGRAVITY_LAUNCH_SPEC = {
  ...ORCA_HOME_LAUNCH_SPEC,
  hostBackend: {
    spec: AGY_HOME_LAUNCH_SPEC,
    pins: isAntigravityHostAccountHome,
    // A Gemini API key or gcloud saved in Orca keeps new chats on Orca's home; Google uses agy's.
    select: async (input) => {
      if (antigravityChatUsesOrcaHome(input.settings.antigravityChatAuth)) {
        return null
      }
      // A chat starting is someone using agy, so its sign-in is asked for the chat's notice.
      if (input.startsProgram) {
        await antigravityAgySignIn(input).catch(() => undefined)
      }
      return antigravityHostAccountHome(input.homePath)
    }
  }
} satisfies AcpLaunchSpec
