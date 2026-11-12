import type { AntigravityChatAuthConfig } from '../../../shared/antigravity-chat-auth-config'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { AcpHistoryTurnIdentity } from '../history/acp-history-replay'
import type { AcpDialect } from '../acp-dialects/acp-dialect'
import type { AcpAccountBinding } from './acp-account-binding'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { AgentChatPermissionMode } from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { ManagedRuntime } from '../../node-runtime/managed-runtime-release'
import type { AcpVisualsSkillLoader } from './acp-visuals-skill'
import type {
  StructuredAgentSessionHistory,
  StructuredAgentTranscriptImport
} from '../../native-chat/structured-agent-cli-conversations'
import type { StructuredAgentCommandSettings } from '../../native-chat/structured-agent-command-resolution'

import type { AcpSignInWatch } from '../process/acp-agent-connection'
import type { AcpPromptTurnTracker } from '../protocol/acp-session-runtime-options'
import type { AcpLaunchGate } from './acp-launch-gate'
import type { AgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/agent-session-account-home'
import type { AcpModelDiscovery } from '../discovery/acp-model-discovery-policy'

export type AcpLaunchSpec = {
  agent: TuiAgent
  command: string
  /** The terminal agent's Command setting may name a different program than this chat server. */
  ignoreAgentCommandSetting?: true
  /** `model` is the chat's saved model, passed only to specs that launch with it. */
  args(input: { fullAccess: boolean; pluginDir: string | null; model?: string }): string[]
  /** The ACP model option cannot name every selection the CLI resolves, so the launch line carries it. */
  launchesWithModel?: true
  /** Applied after the account and user environment. */
  env: Readonly<Record<string, string>>
  /** Scrubs inherited Orca plumbing and returns keys to omit entirely. */
  scrubEnvironment?(env: Record<string, string>, inherited: NodeJS.ProcessEnv): string[]
  dialect: AcpDialect
  loginCommand: readonly string[]
  /** Selects authentication from the execution host's resolved launch inputs. */
  authMethod?(input: {
    advertised: readonly string[]
    antigravityChatAuth?: AntigravityChatAuthConfig
    env: Readonly<Record<string, string>>
  }): string | undefined
  authMethodUnavailableMessage?: string
  /** A valid sign-in output line closes the chat signed out. */
  signIn?: Omit<AcpSignInWatch, 'link'>
  account: AcpAccountBinding
  /** Ascending release-line minimums, checked before creation and at every launch. */
  minimumVersions?: readonly string[]
  /** Searched after PATH. */
  installDirectories(input: { env: Readonly<Record<string, string>>; homePath: string }): string[]
  /** Installed only on request; takes precedence over PATH and excludes `minimumVersions`. */
  managedRuntime?: ManagedRuntime
  /** Agent-enforced modes; Orca does not answer its permission requests. */
  permissionModeConfig?: {
    values: { ask: string } & Partial<Record<AgentChatPermissionMode, string>>
    /** `args` grants full access; its session mode can equal another mode's. */
    fullAccessAtLaunch?: true
  }
  /** Enables /compact as a prompt command. */
  compaction?: true
  /** The agent's `/compact` honours text after the command; others would silently drop it. */
  compactionInstructions?: true
  /** Rejects copy arguments that route the CLI away from the copy's store. */
  assertCopyLaunchArgs?: (args: readonly string[], prefixArgs?: readonly string[]) => void
  /** How the agent names each turn its reopen replays, when a reopened chat catches up on the
   *  turns made outside it; absent, the replay is only dropped. */
  historyCatchUp?: AcpHistoryTurnIdentity
  modelDiscovery: AcpModelDiscovery
  visualsSkill?: AcpVisualsSkillLoader
  transcriptImport: StructuredAgentTranscriptImport | null
  sessionHistory: StructuredAgentSessionHistory
  /** Isolate processes whose agent temp files collide. */
  privateTempDirectory?: true
  /** Prefer session/resume even when loading is supported. */
  resumePreference?: 'resume'
  /** Metadata to include in session start requests (session/new, session/load, session/resume). */
  sessionMeta?(input: {
    cwd: string
    env: Readonly<Record<string, string>>
  }):
    | Promise<Readonly<Record<string, unknown>> | undefined>
    | Readonly<Record<string, unknown>>
    | undefined
  launchGate?: AcpLaunchGate
  /** Writes sessions it cannot delete into the user's own history, so it runs no naming tasks. */
  keepsEverySession?: true
  /** Optional prompt-turn tracker for out-of-band transcript wakeups. */
  turnTracker?(
    env: Readonly<Record<string, string>>,
    now: () => number,
    recoverableTaskIds?: () => ReadonlySet<string> | null
  ): AcpPromptTurnTracker
  /** A program on the host preferred for new chats; chats whose account home it pins keep it. */
  hostBackend?: AcpHostBackend
}

export type AcpHostBackend = {
  spec: AcpLaunchSpec
  pins(home: AgentSessionAccountHome): boolean
  /** The account home pinning a new chat to `spec`, or null when the host should not run it. */
  select(input: {
    command: string
    prefixArgs: readonly string[]
    env: Record<string, string>
    envToDelete: string[]
    homePath: string
    /** Orca's data folder on this host, where the agent's own account lives. */
    stateDirectory: string
    /** The account type Orca's own Chat signs in with, saved on this host. */
    settings: AcpHostBackendSettings
  }): Promise<AgentSessionAccountHome | null>
}

export type AcpHostBackendSettings = StructuredAgentCommandSettings &
  Partial<Pick<GlobalSettings, 'antigravityChatAuth'>>
