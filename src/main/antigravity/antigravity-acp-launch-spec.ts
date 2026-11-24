// Antigravity chats run Orca's managed ACP server, or the host's own `agy acp` when compatible.

import { join } from 'node:path'
import { homedir } from 'node:os'
import type { AcpHostBackendInput, AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import {
  antigravityAgyOrcaHomeRevision,
  antigravityChatRoute,
  onAntigravityAgyOrcaHomeChanged
} from './antigravity-chat-route'
import { ORCA_ACP_CLIENT_INFO } from '../acp/launch/acp-client-info'
import { windowsLocalAppDataBinDirectories } from '../acp/launch/acp-windows-install-directories'
import type { Implementation } from '../acp/generated/acp-protocol.generated'
import {
  ANTIGRAVITY_ACP_DIALECT,
  ANTIGRAVITY_AGY_ORCA_HOME_DIALECT
} from '../acp/acp-dialects/antigravity-dialect'
import type { AgentSessionAccountHome } from '../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import {
  AGY_ORCA_HOME_MINIMUM_VERSION,
  agyOrcaHomeArgs,
  antigravityAgyOrcaAccount,
  antigravityAgyOrcaAccountHome,
  discardAgyOrcaListingSession,
  isAntigravityAgyOrcaAccountHome
} from './antigravity-agy-orca-home'
import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { ANTIGRAVITY_TRANSCRIPT_IMPORT } from './antigravity-transcript-import'
import { resolveAntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { deliverAntigravityInstructions } from '../acp/launch/acp-instructions'
import { ANTIGRAVITY_ACP_COMMAND, ANTIGRAVITY_ACP_RUNTIME } from './antigravity-acp-runtime'
import {
  compareAppVersions,
  isValidAppVersion
} from '../../shared/app-lifecycle/identity/app-version'
import { ANTIGRAVITY_ACP_ENV, scrubAntigravityAcpEnvironment } from './antigravity-acp-environment'
import { scrubAgyOrcaHomeEnvironment } from './antigravity-agy-orca-home-environment'
import {
  ANTIGRAVITY_LAUNCH_GATE,
  answerAntigravityChatAuth,
  antigravityChatAccount
} from './antigravity-chat-account'
import { readAntigravitySignInLine } from './antigravity-sign-in-url'
import { antigravityChatRulesMeta } from './antigravity-chat-rules'
import { discardAntigravityListingSession } from './antigravity-listing-session'
import { parseAgyModelListing } from './antigravity-model-listing'
import { managedRuntimeReleasesRevision } from '../node-runtime/managed-runtime-installation'
import {
  AGY_SKIP_PERMISSIONS_FLAG,
  antigravityHostAcpChecksRevision,
  onAntigravityHostAcpAnswersChanged,
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

const ZED_CLIENT_INFO: Implementation = { name: 'zed', version: '0.0.0' }

// Google's ACP server (still in 1.5.2) offers non-Gemini models only to allowlisted editors such
// as Zed; named `orca`, a Google-account chat loses Claude and GPT-OSS. Its versions are not agy's.
const managedServerClientInfo = (): Implementation => ZED_CLIENT_INFO

// agy 1.5.1 and later offer every model to any client. Orca requires a newer agy, so `zed` is only
// the fallback when agy's version is unknown.
function agyClientInfo(version: string | null): Implementation {
  return version && isValidAppVersion(version) && compareAppVersions(version, '1.5.1') >= 0
    ? ORCA_ACP_CLIENT_INFO
    : ZED_CLIENT_INFO
}

// Orca's managed ACP server keeps its own sign-in under <userData>/antigravity-chat.
const ANTIGRAVITY_MANAGED_LAUNCH_SPEC = {
  agent: 'antigravity',
  command: ANTIGRAVITY_ACP_COMMAND,
  ignoreAgentCommandSetting: true,
  // Without --uid=, the Linux server drops root launches to nobody.
  args: () => (process.platform === 'linux' ? ['--uid='] : []),
  env: ANTIGRAVITY_ACP_ENV,
  scrubEnvironment: scrubAntigravityAcpEnvironment,
  dialect: ANTIGRAVITY_ACP_DIALECT,
  clientInfo: managedServerClientInfo,
  loginCommand: agentSessionSetupFor('antigravity')?.loginCommand ?? [],
  authMethod: ({ antigravityChatAuth }) =>
    resolveAntigravityChatAuthConfig(antigravityChatAuth).method,
  authMethodUnavailableMessage:
    'Antigravity does not support the selected account type. Update Antigravity or change the account type in Settings.',
  signIn: {
    read: readAntigravitySignInLine,
    answered: answerAntigravityChatAuth
  },
  account: antigravityChatAccount,
  installDirectories: () => [],
  managedRuntime: ANTIGRAVITY_ACP_RUNTIME,
  managedRuntimeUpdatesAllowed: (settings) => settings.antigravityServerAutoUpdateEnabled !== false,
  // Yolo still requests questions and administrative reviews.
  permissionModeConfig: {
    values: { ask: 'default', 'accept-edits': 'auto_edit', 'full-access': 'yolo' }
  },
  // Its server lists models only in a session, which it keeps, so Orca removes it.
  modelDiscovery: {
    kind: 'session',
    listingNamesConfiguredModel: false,
    inPrivateFolder: true,
    // The server unpacks about 1 GB per start (29s cold here), so only a picker asking starts it.
    listsOnDemand: true,
    discardSession: discardAntigravityListingSession
  },
  instructions: deliverAntigravityInstructions,
  transcriptImport: ANTIGRAVITY_TRANSCRIPT_IMPORT,
  sessionHistory: ANTIGRAVITY_SESSION_HISTORY,
  privateTempDirectory: true,
  // The server otherwise writes its workflow tool into every chat workspace.
  sessionMeta: { antigravity: { disabledTools: ['run_workflow'] } },
  // `session/load` replays the whole conversation, which the chat already holds.
  resumePreference: 'resume',
  resolveSessionMeta: antigravityChatRulesMeta,
  launchGate: ANTIGRAVITY_LAUNCH_GATE
} satisfies AcpLaunchSpec

// An inherited Gemini API key switches agy to key auth, which its models reject (401);
// alternate-case updater flags on Windows would shadow the configured uppercase entry.
function scrubAgyHostApiKeys(env: Record<string, string>, inherited: NodeJS.ProcessEnv): string[] {
  const removed = [...new Set([...Object.keys(env), ...Object.keys(inherited)])].filter((key) => {
    const normalized = process.platform === 'win32' ? key.toUpperCase() : key
    const shadowsDisableAutoUpdate =
      process.platform === 'win32' &&
      normalized === 'AGY_CLI_DISABLE_AUTO_UPDATE' &&
      key !== normalized
    return (
      shadowsDisableAutoUpdate || normalized === 'GEMINI_API_KEY' || normalized === 'GOOGLE_API_KEY'
    )
  })
  for (const key of removed) {
    delete env[key]
  }
  return removed
}

// The host's `agy acp` uses agy's own sign-in and history; Orca neither signs it in nor out.
const ANTIGRAVITY_HOST_LAUNCH_SPEC: AcpLaunchSpec = {
  ...ANTIGRAVITY_MANAGED_LAUNCH_SPEC,
  command: 'agy',
  // Off, Orca's agy runs no chat: chats pinned to agy run the user's own (same ~/.gemini history),
  // and on a host without one they get launch's cliMissing refusal.
  managedCopyAllowed: (settings) => settings.antigravityManagedAgyEnabled !== false,
  args: ({ fullAccess }) => ['acp', ...(fullAccess ? [AGY_SKIP_PERMISSIONS_FLAG] : [])],
  clientInfo: agyClientInfo,
  // Match terminal and quota launches: a background updater steals focus on Windows (#27390)
  // and can replace agy mid-probe.
  env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
  scrubEnvironment: scrubAgyHostApiKeys,
  authMethod: undefined,
  authMethodUnavailableMessage: undefined,
  signIn: undefined,
  dialect: { ...ANTIGRAVITY_ACP_DIALECT, signInAccount: 'system' },
  // `agy models` lists without opening a session.
  modelDiscovery: {
    kind: 'command',
    args: ['models'],
    parse: parseAgyModelListing,
    listingNamesConfiguredModel: false
  },
  account: {
    pin: antigravityChatAccount.pin,
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
  managedRuntime: undefined,
  managedRuntimeUpdatesAllowed: undefined,
  resolveSessionMeta: undefined,
  // agy has no full-access mode, so its launch flag grants it; plan approvals still reach the chat.
  permissionModeConfig: {
    values: { ask: 'default', 'accept-edits': 'accept-edits', 'full-access': 'default' },
    fullAccessAtLaunch: true
  },
  keepsEverySession: true,
  sessionMeta: undefined
}

// agy on a home Orca owns, for Gemini API key chats: the saved method's settings.json
// and credential, apart from agy's own login.
const ANTIGRAVITY_AGY_ORCA_HOME_LAUNCH_SPEC: AcpLaunchSpec = {
  ...ANTIGRAVITY_HOST_LAUNCH_SPEC,
  readsAntigravityChatAuth: true,
  scrubEnvironment: scrubAgyOrcaHomeEnvironment,
  dialect: ANTIGRAVITY_AGY_ORCA_HOME_DIALECT,
  account: antigravityAgyOrcaAccount,
  // `agy models` can't be pointed at this home, so a session lists them, and is then removed.
  modelDiscovery: {
    kind: 'session',
    listingNamesConfiguredModel: false,
    inPrivateFolder: true,
    listsOnDemand: true,
    discardSession: discardAgyOrcaListingSession
  },
  minimumVersions: [AGY_ORCA_HOME_MINIMUM_VERSION]
}

/** The Orca-home spec for one home: agy is pointed at it on every launch. */
function agyOrcaHomeSpec(home: AgentSessionAccountHome): AcpLaunchSpec {
  return {
    ...ANTIGRAVITY_AGY_ORCA_HOME_LAUNCH_SPEC,
    args: (options) => [...ANTIGRAVITY_HOST_LAUNCH_SPEC.args(options), ...agyOrcaHomeArgs(home)]
  }
}

/** Where new chats run here, and what Install puts here; select and Install read the same answer. */
export function antigravityHostChatRoute(input: AcpHostBackendInput) {
  return antigravityChatRoute(input, ANTIGRAVITY_MANAGED_LAUNCH_SPEC)
}

export const ANTIGRAVITY_LAUNCH_SPEC = {
  ...ANTIGRAVITY_MANAGED_LAUNCH_SPEC,
  hostBackend: {
    spec: ANTIGRAVITY_HOST_LAUNCH_SPEC,
    pins: (home) => isAntigravityHostAccountHome(home) || isAntigravityAgyOrcaAccountHome(home),
    specFor: (home) => (isAntigravityAgyOrcaAccountHome(home) ? agyOrcaHomeSpec(home) : null),
    otherSpecs: [ANTIGRAVITY_AGY_ORCA_HOME_LAUNCH_SPEC],
    // Unasked readers (menus, catalogs) get what a chat start would pin, from earlier answers.
    select: async (input) => {
      const route = await antigravityHostChatRoute(input)
      if (route.orcaHome) {
        return antigravityAgyOrcaAccountHome(input.stateDirectory)
      }
      return route.agy ? antigravityHostAccountHome(input.homePath) : null
    },
    installsManagedRuntime: async (input) =>
      (await antigravityHostChatRoute(input)).installs === 'server',
    // Installing Orca's agy, a new agy login, a changed agy answer or a key coming or going
    // changes the route.
    selectionRevision: () =>
      managedRuntimeReleasesRevision() +
      antigravityHostAcpChecksRevision() +
      antigravityAgyOrcaHomeRevision(),
    onSelectionChanged: (listener) => {
      const answers = onAntigravityHostAcpAnswersChanged(listener)
      const keys = onAntigravityAgyOrcaHomeChanged(listener)
      return () => {
        answers()
        keys()
      }
    }
  }
} satisfies AcpLaunchSpec
