// Antigravity chats run Orca's managed ACP server, or the host's own `agy acp` when compatible.

import { join } from 'node:path'
import { homedir } from 'node:os'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { ANTIGRAVITY_ACP_DIALECT } from '../acp/acp-dialects/antigravity-dialect'
import type { StructuredAgentSessionHistory } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import {
  AntigravityChatAuthConfigSchema,
  resolveAntigravityChatAuthConfig
} from '../../shared/antigravity-chat-auth-config'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/agent-session-setup-commands'
import { ANTIGRAVITY_ACP_COMMAND, ANTIGRAVITY_ACP_RUNTIME } from './antigravity-acp-runtime'
import { ANTIGRAVITY_ACP_ENV, scrubAntigravityAcpEnvironment } from './antigravity-acp-environment'
import {
  ANTIGRAVITY_LAUNCH_GATE,
  answerAntigravityChatAuth,
  antigravityChatAccount,
  antigravityChatSignIn
} from './antigravity-chat-account'
import { ANTIGRAVITY_CHAT_HOME_FOLDER } from './antigravity-chat-home'
import { assertAntigravityChatAuthPublished } from './antigravity-chat-auth-publication'
import { readAntigravitySignInLine } from './antigravity-sign-in-url'
import {
  AGY_SKIP_PERMISSIONS_FLAG,
  ANTIGRAVITY_HOST_ACP_MINIMUM_VERSION,
  antigravityHostAccountHome,
  agyUsesApiKey,
  antigravityHostAcpReady,
  hasAgyCredential,
  hasManagedAntigravityChatSignIn,
  isAntigravityHostAccountHome
} from './antigravity-host-acp'

// Chats cannot adopt agy's terminal conversations.
const ANTIGRAVITY_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['antigravity'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: () => null
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
  modelDiscovery: {
    kind: 'unavailable',
    reason: 'the Antigravity server lists its models only in a signed-in session'
  },
  transcriptImport: null,
  sessionHistory: ANTIGRAVITY_SESSION_HISTORY,
  privateTempDirectory: true,
  // `session/load` replays the whole conversation, which the chat already holds.
  resumePreference: 'resume',
  launchGate: ANTIGRAVITY_LAUNCH_GATE
} satisfies AcpLaunchSpec

// An inherited Gemini API key switches agy to key auth, which its models reject (401).
function scrubAgyHostApiKeys(env: Record<string, string>): string[] {
  const removed = ['GEMINI_API_KEY', 'GOOGLE_API_KEY']
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
  env: {},
  scrubEnvironment: scrubAgyHostApiKeys,
  authMethod: undefined,
  authMethodUnavailableMessage: undefined,
  signIn: undefined,
  dialect: { ...ANTIGRAVITY_ACP_DIALECT, signInAccount: 'system' },
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
  installDirectories: ({ homePath }) => [join(homePath, '.local', 'bin')],
  managedRuntime: undefined,
  // agy has no full-access mode, so its launch flag grants it; plan approvals still reach the chat.
  permissionModeConfig: {
    values: { ask: 'default', 'accept-edits': 'accept-edits', 'full-access': 'default' },
    fullAccessAtLaunch: true
  },
  keepsEverySession: true
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
    // Someone signed in to Orca's own Chat keeps it; the host's agy needs a sign-in that serves
    // sessions, not an API-key provider whose key the host launch drops.
    select: async ({ command, env, envToDelete, homePath, stateDirectory, settings }) =>
      savedChatAuthIsPersonal(settings.antigravityChatAuth) &&
      antigravityChatSignIn.get().value.auth !== 'signedIn' &&
      !(await hasManagedAntigravityChatSignIn(
        join(stateDirectory, ANTIGRAVITY_CHAT_HOME_FOLDER)
      )) &&
      !(await agyUsesApiKey(homePath)) &&
      (await hasAgyCredential(homePath)) &&
      (await antigravityHostAcpReady(command, env, envToDelete))
        ? antigravityHostAccountHome(homePath)
        : null
  }
} satisfies AcpLaunchSpec
