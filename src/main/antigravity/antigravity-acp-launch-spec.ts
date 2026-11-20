// Antigravity chats run Orca's managed ACP server, or the host's own `agy acp` when compatible.

import { join, win32 } from 'node:path'
import { homedir } from 'node:os'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { ORCA_ACP_CLIENT_INFO } from '../acp/launch/acp-client-info'
import type { Implementation } from '../acp/generated/acp-protocol.generated'
import { ANTIGRAVITY_ACP_DIALECT } from '../acp/acp-dialects/antigravity-dialect'
import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { ANTIGRAVITY_TRANSCRIPT_IMPORT } from './antigravity-transcript-import'
import {
  AntigravityChatAuthConfigSchema,
  resolveAntigravityChatAuthConfig
} from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { deliverAntigravityInstructions } from '../acp/launch/acp-instructions'
import { ANTIGRAVITY_ACP_COMMAND, ANTIGRAVITY_ACP_RUNTIME } from './antigravity-acp-runtime'
import {
  compareAppVersions,
  isValidAppVersion
} from '../../shared/app-lifecycle/identity/app-version'
import { ANTIGRAVITY_ACP_ENV, scrubAntigravityAcpEnvironment } from './antigravity-acp-environment'
import {
  ANTIGRAVITY_LAUNCH_GATE,
  answerAntigravityChatAuth,
  antigravityChatAccount
} from './antigravity-chat-account'
import { assertAntigravityChatAuthPublished } from './antigravity-chat-auth-publication'
import { readAntigravitySignInLine } from './antigravity-sign-in-url'
import { antigravityChatRulesMeta } from './antigravity-chat-rules'
import { discardAntigravityListingSession } from './antigravity-listing-session'
import { parseAgyModelListing } from './antigravity-model-listing'
import {
  AGY_SKIP_PERMISSIONS_FLAG,
  ANTIGRAVITY_HOST_ACP_MINIMUM_VERSION,
  antigravityHostAccountHome,
  agyUsesApiKey,
  antigravityHostAcpReady,
  hasAgyCredential,
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

// Servers before 1.5.1 offer non-Gemini models only to allowlisted editors such as Zed.
function antigravityClientInfo(version: string | null): Implementation {
  return version && isValidAppVersion(version) && compareAppVersions(version, '1.5.1') >= 0
    ? ORCA_ACP_CLIENT_INFO
    : { name: 'zed', version: '0.0.0' }
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
  clientInfo: antigravityClientInfo,
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
  args: ({ fullAccess }) => ['acp', ...(fullAccess ? [AGY_SKIP_PERMISSIONS_FLAG] : [])],
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
  installDirectories: ({ env, homePath }) => {
    if (process.platform !== 'win32') {
      return [join(homePath, '.local', 'bin')]
    }
    const localAppData = Object.entries(env)
      .find(([key]) => key.toUpperCase() === 'LOCALAPPDATA')?.[1]
      ?.trim()
    return [
      ...new Set([
        ...(localAppData && win32.isAbsolute(localAppData)
          ? [join(localAppData, 'agy', 'bin')]
          : []),
        join(homePath, 'AppData', 'Local', 'agy', 'bin'),
        join(homePath, '.local', 'bin')
      ])
    ]
  },
  managedRuntime: undefined,
  resolveSessionMeta: undefined,
  // agy has no full-access mode, so its launch flag grants it; plan approvals still reach the chat.
  permissionModeConfig: {
    values: { ask: 'default', 'accept-edits': 'accept-edits', 'full-access': 'default' },
    fullAccessAtLaunch: true
  },
  keepsEverySession: true,
  sessionMeta: undefined
}

// The host's agy ignores Orca's account type, so any other saved choice, a malformed one, or one
// still being saved keeps new chats on Orca's runtime, whose sign-in honors it.
function savedChatAuthIsPersonal(value: unknown): boolean {
  try {
    assertAntigravityChatAuthPublished(value)
  } catch {
    return false
  }
  const parsed = AntigravityChatAuthConfigSchema.safeParse(
    value === undefined ? { method: 'oauth-personal' } : value
  )
  return parsed.success && parsed.data.method === 'oauth-personal'
}

export const ANTIGRAVITY_LAUNCH_SPEC = {
  ...ANTIGRAVITY_MANAGED_LAUNCH_SPEC,
  hostBackend: {
    spec: ANTIGRAVITY_HOST_LAUNCH_SPEC,
    pins: isAntigravityHostAccountHome,
    // A signed-in agy wins over Orca's own sign-in, so chats use the account Accounts switches and
    // the usage meter reads (#44613). It needs a sign-in that serves sessions, not an API-key
    // provider whose key the host launch drops.
    select: async ({ command, env, envToDelete, homePath, settings }) =>
      savedChatAuthIsPersonal(settings.antigravityChatAuth) &&
      !(await agyUsesApiKey(homePath)) &&
      (await hasAgyCredential(homePath)) &&
      (await antigravityHostAcpReady(command, env, envToDelete))
        ? antigravityHostAccountHome(homePath)
        : null
  }
} satisfies AcpLaunchSpec
