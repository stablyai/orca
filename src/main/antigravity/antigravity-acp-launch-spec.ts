// Antigravity chats run Orca's managed ACP server, or the host's own `agy acp` when compatible.

import { join } from 'node:path'
import { homedir } from 'node:os'
import type { AcpLaunchSpec } from '../acp/acp-launch-specs'
import { ANTIGRAVITY_ACP_DIALECT } from '../acp/acp-dialects/antigravity-dialect'
import type { StructuredAgentSessionHistory } from '../native-chat/structured-agent-cli-conversations'
import { agentSessionSignInFor } from '../../shared/agent-session/lifecycle/agent-session-sign-in'
import { ANTIGRAVITY_ACP_COMMAND, ANTIGRAVITY_ACP_RUNTIME } from './antigravity-acp-runtime'
import { ANTIGRAVITY_ACP_ENV, scrubAntigravityAcpEnvironment } from './antigravity-acp-environment'
import {
  ANTIGRAVITY_LAUNCH_GATE,
  answerAntigravityChatAuth,
  antigravityChatAccount,
  antigravityChatSignIn
} from './antigravity-chat-account'
import { ANTIGRAVITY_CHAT_HOME_FOLDER } from './antigravity-chat-home'
import { readAntigravitySignInLine } from './antigravity-sign-in-url'
import {
  ANTIGRAVITY_HOST_ACP_MINIMUM_VERSION,
  antigravityHostAccountHome,
  antigravityHostAcpAnswers,
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
  loginCommand: agentSessionSignInFor('antigravity')?.loginCommand ?? [],
  authMethod: ({ advertised }) =>
    advertised.includes('oauth-personal') ? 'oauth-personal' : undefined,
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

// The host's `agy acp` uses agy's own sign-in and history; Orca neither signs it in nor out.
const ANTIGRAVITY_HOST_LAUNCH_SPEC: AcpLaunchSpec = {
  ...ANTIGRAVITY_MANAGED_LAUNCH_SPEC,
  command: 'agy',
  args: () => ['acp'],
  env: {},
  scrubEnvironment: undefined,
  authMethod: undefined,
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
  // agy has no full-access mode: such chats start on Orca's runtime, and a switch fails the start.
  permissionModeConfig: { values: { ask: 'default', 'accept-edits': 'accept-edits' } },
  keepsEverySession: true
}

export const ANTIGRAVITY_LAUNCH_SPEC = {
  ...ANTIGRAVITY_MANAGED_LAUNCH_SPEC,
  hostBackend: {
    spec: ANTIGRAVITY_HOST_LAUNCH_SPEC,
    pins: isAntigravityHostAccountHome,
    // Someone signed in to Orca's own Chat keeps it; the host's agy needs its own sign-in.
    select: async ({ command, env, envToDelete, homePath, stateDirectory }) =>
      antigravityChatSignIn.get().value.auth !== 'signedIn' &&
      !(await hasManagedAntigravityChatSignIn(
        join(stateDirectory, ANTIGRAVITY_CHAT_HOME_FOLDER)
      )) &&
      (await hasAgyCredential(homePath)) &&
      (await antigravityHostAcpAnswers(command, env, envToDelete))
        ? antigravityHostAccountHome(homePath)
        : null
  }
} satisfies AcpLaunchSpec
