import type { AntigravityChatAuthConfig } from '../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import type { AcpHistoryTurnIdentity } from '../history/acp-history-replay'
import type { AcpDialect } from '../acp-dialects/acp-dialect'
import type { AcpAccountBinding } from './acp-account-binding'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { AgentChatPermissionMode } from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { ManagedRuntime } from '../../node-runtime/managed-runtime-release'
import type { AcpSkillRootsLoader } from './acp-skill-roots'
import type { AcpInstructionsDelivery } from './acp-instructions'
import type {
  StructuredAgentSessionHistory,
  StructuredAgentTranscriptImport
} from '../../native-chat/conversation-adoption/structured-agent-cli-conversations'

import type { AcpSignInWatch } from '../process/acp-agent-connection'
import type { AcpLaunchGate } from './acp-launch-gate'
import type { AgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { AcpModelDiscovery } from '../discovery/acp-model-discovery-policy'
import type {
  Implementation,
  InitializeResponse,
  McpServer
} from '../generated/acp-protocol.generated'

export type AcpLaunchSpec = {
  agent: TuiAgent
  command: string
  /** The terminal agent's Command setting may name a different program than this chat server. */
  ignoreAgentCommandSetting?: true
  /** `model` is the chat's saved model, passed only to specs that launch with it. */
  args(input: { fullAccess: boolean; pluginDirs: readonly string[]; model?: string }): string[]
  /** The ACP model option cannot name every selection the CLI resolves, so the launch line carries it. */
  launchesWithModel?: true
  /** Applied after the account and user environment. */
  env: Readonly<Record<string, string>>
  /** Scrubs inherited Orca plumbing and returns keys to omit entirely; the chat's saved
   *  Antigravity account type keeps the credentials it reads. */
  scrubEnvironment?(
    env: Record<string, string>,
    inherited: NodeJS.ProcessEnv,
    antigravityChatAuth?: AntigravityChatAuthConfig
  ): string[]
  dialect: AcpDialect
  /** Initialize's identity for the launched version (null when unknown), for agents that grant
   *  features by client name; absent sends Orca's. */
  clientInfo?(version: string | null): Implementation
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
  /** Arguments before `--version` when the bare flag is slow or not the chat server's version. */
  versionArgs?: readonly string[]
  /** Searched after PATH. */
  installDirectories(input: { env: Readonly<Record<string, string>>; homePath: string }): string[]
  /** Installed only on request; takes precedence over PATH and excludes `minimumVersions`. */
  managedRuntime?: ManagedRuntime
  /** Agent-enforced modes; Orca does not answer its permission requests. */
  permissionModeConfig?: {
    values: { ask: string } & Partial<Record<AgentChatPermissionMode, string>>
    /** `args` grants full access; its session mode can equal another mode's. */
    fullAccessAtLaunch?: true
    /** The modes govern only some requests; under full access Orca answers the rest itself. */
    fullAccessAnswersRequests?: true
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
  /** Loads Orca's visuals skill and linked projects' skills; absent loads none. */
  skillRoots?: AcpSkillRootsLoader
  /** The agent's own MCP servers, for an agent whose ACP mode connects only the client's; absent,
   *  the agent loads its own. */
  ownMcpServers?: AcpOwnMcpServersLoader
  /** Why a bot's own tools never reach this agent (its ACP server ignores a session's MCP servers):
   *  its chats start without them and are told so, and its Tools rows show them off. */
  botToolsOff?: string
  /** How a session's standing instructions reach the agent's system prompt; absent, a session
   *  with any cannot start. */
  instructions?: AcpInstructionsDelivery
  /** `instructions` writes into the chat's own folder, so Orca never adds any just for visuals. */
  instructionsInWorkspace?: true
  transcriptImport: StructuredAgentTranscriptImport | null
  sessionHistory: StructuredAgentSessionHistory
  /** Tools run in a process other chats share, which keeps the environment of the chat that
   *  started it; such chats carry no caller identity, so Orca's CLI there refuses to guess one. */
  sharedToolProcess?: true
  /** Isolate processes whose agent temp files collide. */
  privateTempDirectory?: true
  /** Prefer session/resume even when loading is supported. */
  resumePreference?: 'resume'
  /** Extra ACP session metadata required by this provider's protocol implementation. */
  sessionMeta?: Readonly<Record<string, unknown>>
  /** Conversation-only configuration, resolved again when a process reopens its session. */
  resolveSessionMeta?(input: {
    initialized: InitializeResponse
    cwd: string
    env: Readonly<Record<string, string>>
    signal?: AbortSignal
  }): Promise<Readonly<Record<string, unknown>> | undefined>
  launchGate?: AcpLaunchGate
  /** Writes sessions it cannot delete into the user's own history, so it runs no naming tasks. */
  keepsEverySession?: true
  /** A program on the host preferred for new chats; chats whose account home it pins keep it. */
  hostBackend?: AcpHostBackend
  /** Whether Orca's own copy of this program may run (and be kept updated); absent means it may. */
  managedCopyAllowed?(settings: ManagedCopySettings): boolean
}

/** Reads on the host the agent runs on; a missing or unreadable file contributes none. */
export type AcpOwnMcpServersLoader = (input: {
  cwd: string
  env: Readonly<Record<string, string>>
  version: string | null
}) => Promise<McpServer[]>

export type ManagedCopySettings = Partial<Pick<GlobalSettings, 'antigravityManagedAgyEnabled'>>

/** What the host backend weighs: the host program a launch would run, and this host's facts. */
export type AcpHostBackendInput = {
  /** Absolute when the host program resolves; otherwise the bare name nothing answered for. */
  command: string
  env: Record<string, string>
  envToDelete: string[]
  homePath: string
  /** Orca's data folder on this host, where the agent's own account lives. */
  stateDirectory: string
  /** The account type Orca's own Chat signs in with, saved on this host. */
  settings: AcpHostBackendSettings
  /** The question comes from someone using the agent, so it may start the program to answer;
   *  otherwise only what is already known (files, earlier answers) decides. */
  startsProgram: boolean
}

export type AcpHostBackend = {
  spec: AcpLaunchSpec
  pins(home: AgentSessionAccountHome): boolean
  /** The account home pinning a new chat to `spec`, or null when the host should not run it. It
   *  may pin a program `input.command` didn't find, which an Install then provides. */
  select(input: AcpHostBackendInput): Promise<AgentSessionAccountHome | null>
  /** Changes whenever a sign-in that `select` weighs changes, so remembered answers are retired. */
  selectionRevision?(): number
  /** Tells when a fact `select` weighs changes apart from settings and Orca's installs. */
  onSelectionChanged?(listener: () => void): () => void
  /** Where Orca also keeps its own copy of the host program: whether Install, its status and
   *  removal act on the outer spec's `managedRuntime` instead of that copy. */
  installsManagedRuntime?(input: AcpHostBackendInput): Promise<boolean>
}

/** The settings a host backend weighs; a change to any of them can change its answers. */
export const ACP_HOST_BACKEND_SETTING_KEYS = [
  'antigravityChatAuth',
  'antigravityManagedAgyEnabled',
  'antigravityGoogleSignIn',
  'agentCmdOverrides'
] as const
export type AcpHostBackendSettings = Partial<
  Pick<GlobalSettings, (typeof ACP_HOST_BACKEND_SETTING_KEYS)[number]>
>
