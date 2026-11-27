// Every Antigravity chat runs `agy acp`: on agy's own home and login for a Google account, or on a
// home Orca owns (`--gemini-dir`) for any other method, and for chats Orca's retired server started.

import { join } from 'node:path'
import { homedir } from 'node:os'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import type { AcpSessionModelDiscovery } from '../acp/discovery/acp-model-discovery-policy'
import {
  antigravityAgyOrcaHomeRevision,
  antigravityChatRunsOnAgyHome,
  onAntigravityAgyOrcaHomeChanged
} from './antigravity-chat-route'
import { windowsLocalAppDataBinDirectories } from '../acp/launch/acp-windows-install-directories'
import {
  ANTIGRAVITY_ACP_DIALECT,
  ANTIGRAVITY_AGY_ORCA_HOME_DIALECT
} from '../acp/acp-dialects/antigravity-dialect'
import type { AgentSessionAccountHome } from '../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import {
  agyOrcaHomeArgs,
  antigravityAgyOrcaAccount,
  antigravityAgyOrcaAccountHome,
  antigravityLegacyOrcaAccount,
  antigravityOrcaHomeFolder,
  ANTIGRAVITY_AGY_CHAT_HOME_FOLDER
} from './antigravity-agy-orca-home'
import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { ANTIGRAVITY_TRANSCRIPT_IMPORT } from './antigravity-transcript-import'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { deliverAntigravityInstructions } from '../acp/launch/acp-instructions'
import { scrubAgyOrcaHomeEnvironment } from './antigravity-agy-orca-home-environment'
import { ANTIGRAVITY_LAUNCH_GATE } from './antigravity-chat-account'
import { discardAgyListingSession } from './agy-listing-session-discard'
import { AGY_ACP_CLIENT_INFO } from './antigravity-acp-runtime-probe'
import {
  AGY_SKIP_PERMISSIONS_FLAG,
  ANTIGRAVITY_HOST_ACP_MINIMUM_VERSION,
  antigravityHostAccountHome,
  isAntigravityHostAccountHome
} from './antigravity-host-acp'

// Chats and terminals share agy's conversation store when a chat runs the host's `agy acp`. A bare
// `-c` is not refused: managed chats live elsewhere, so it would block agy for every Chat user.
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

// An alternate-case updater flag on Windows would shadow the configured uppercase entry. A
// GEMINI_API_KEY is left alone: agy uses it only where its own settings pick a key provider.
function scrubAgyHostEnvironment(
  env: Record<string, string>,
  inherited: NodeJS.ProcessEnv
): string[] {
  if (process.platform !== 'win32') {
    return []
  }
  const removed = [...new Set([...Object.keys(env), ...Object.keys(inherited)])].filter(
    (key) =>
      key.toUpperCase() === 'AGY_CLI_DISABLE_AUTO_UPDATE' && key !== 'AGY_CLI_DISABLE_AUTO_UPDATE'
  )
  for (const key of removed) {
    delete env[key]
  }
  return removed
}

// A session lists what a chat is offered; `agy models` can return a shorter fallback list. Its
// session request reads agy's login (a locked Linux keyring raises an unlock prompt), so only an
// Antigravity picker starts it, never startup or settings warm-up.
const AGY_SESSION_MODEL_DISCOVERY: AcpSessionModelDiscovery = {
  kind: 'session',
  listingNamesConfiguredModel: false,
  inPrivateFolder: true,
  listsOnDemand: true,
  discardSession: discardAgyListingSession,
  // Its commands and skills differ per folder (`.agents/skills`), unlike its models.
  listsCommandsInChatFolder: true
}

// agy on its own home uses agy's own sign-in and history; Orca neither signs it in nor out there.
const ANTIGRAVITY_AGY_LAUNCH_SPEC = {
  agent: 'antigravity',
  command: 'agy',
  ignoreAgentCommandSetting: true,
  // Off, Orca's agy runs no chat: chats run the user's own (same ~/.gemini history), and on a host
  // without one they get launch's cliMissing refusal.
  managedCopyAllowed: (settings) => settings.antigravityManagedAgyEnabled !== false,
  args: ({ fullAccess }) => ['acp', ...(fullAccess ? [AGY_SKIP_PERMISSIONS_FLAG] : [])],
  clientInfo: AGY_ACP_CLIENT_INFO,
  // Match terminal and quota launches: a background updater steals focus on Windows (#27390)
  // and can replace agy mid-probe.
  env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
  scrubEnvironment: scrubAgyHostEnvironment,
  dialect: { ...ANTIGRAVITY_ACP_DIALECT, signInAccount: 'system' },
  loginCommand: agentSessionSetupFor('antigravity')?.loginCommand ?? [],
  modelDiscovery: AGY_SESSION_MODEL_DISCOVERY,
  account: {
    pin: { accountHomeVariable: 'GEMINI_HOME' },
    resolve: async ({ launchEnv }) =>
      antigravityHostAccountHome(launchEnv.HOME ?? launchEnv.USERPROFILE ?? homedir()),
    environment: (home, env) => {
      if (!isAntigravityHostAccountHome(home)) {
        throw new Error("this chat runs on the host's agy")
      }
      return env
    }
  },
  minimumVersions: [ANTIGRAVITY_HOST_ACP_MINIMUM_VERSION],
  installDirectories: ({ env, homePath }) => [
    ...(process.platform === 'win32'
      ? windowsLocalAppDataBinDirectories(env, homePath, 'agy')
      : []),
    join(homePath, '.local', 'bin')
  ],
  // agy has no full-access mode, so its launch flag grants it; plan approvals still reach the chat.
  permissionModeConfig: {
    values: { ask: 'default', 'accept-edits': 'accept-edits', 'full-access': 'default' },
    fullAccessAtLaunch: true
  },
  instructions: deliverAntigravityInstructions,
  transcriptImport: ANTIGRAVITY_TRANSCRIPT_IMPORT,
  sessionHistory: ANTIGRAVITY_SESSION_HISTORY,
  privateTempDirectory: true,
  // `session/load` replays the whole conversation, which the chat already holds.
  resumePreference: 'resume',
  launchGate: ANTIGRAVITY_LAUNCH_GATE,
  keepsEverySession: true
} satisfies AcpLaunchSpec

// agy on a home Orca owns: the saved method's settings.json and credential, apart from agy's own
// settings. agy's Google login still serves it (shared keyring, or a copy of its login file).
const ANTIGRAVITY_AGY_ORCA_HOME_LAUNCH_SPEC: AcpLaunchSpec = {
  ...ANTIGRAVITY_AGY_LAUNCH_SPEC,
  readsAntigravityChatAuth: true,
  scrubEnvironment: scrubAgyOrcaHomeEnvironment,
  dialect: ANTIGRAVITY_AGY_ORCA_HOME_DIALECT,
  account: antigravityAgyOrcaAccount
}

/** The Orca-home spec for one home: agy is pointed at it on every launch. */
function agyOrcaHomeSpec(home: AgentSessionAccountHome): AcpLaunchSpec | null {
  const folder = antigravityOrcaHomeFolder(home)
  if (!folder) {
    return null
  }
  return {
    ...ANTIGRAVITY_AGY_ORCA_HOME_LAUNCH_SPEC,
    account:
      folder === ANTIGRAVITY_AGY_CHAT_HOME_FOLDER
        ? antigravityAgyOrcaAccount
        : antigravityLegacyOrcaAccount,
    args: (options) => [...ANTIGRAVITY_AGY_LAUNCH_SPEC.args(options), ...agyOrcaHomeArgs(home)]
  }
}

export const ANTIGRAVITY_LAUNCH_SPEC = {
  ...ANTIGRAVITY_AGY_LAUNCH_SPEC,
  hostBackend: {
    spec: ANTIGRAVITY_AGY_LAUNCH_SPEC,
    pins: (home) => isAntigravityHostAccountHome(home) || antigravityOrcaHomeFolder(home) !== null,
    ownLogin: isAntigravityHostAccountHome,
    followsSelectionBeforeFirstTurn: true,
    specFor: agyOrcaHomeSpec,
    otherSpecs: [ANTIGRAVITY_AGY_ORCA_HOME_LAUNCH_SPEC],
    // The saved method alone picks the home, so nothing here waits on agy.
    select: async (input) =>
      antigravityChatRunsOnAgyHome(input.settings.antigravityChatAuth)
        ? antigravityHostAccountHome(input.homePath)
        : antigravityAgyOrcaAccountHome(input.stateDirectory),
    // A key coming or going decides whether key chats and their listings run.
    selectionRevision: antigravityAgyOrcaHomeRevision,
    onSelectionChanged: onAntigravityAgyOrcaHomeChanged
  }
} satisfies AcpLaunchSpec
