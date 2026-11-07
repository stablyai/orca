import type { AntigravityChatAuthConfig } from '../../shared/antigravity-chat-auth-config'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { AcpHistoryTurnIdentity } from './history/acp-history-replay'
import { join } from 'node:path'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'
import { OMP_ACP_DIALECT } from './acp-dialects/omp-dialect'
import { OPENCODE_ACP_DIALECT } from './acp-dialects/opencode-dialect'
import { directoryAccountBinding, type AcpAccountBinding } from './acp-account-binding'
import { openCodeAcpAccountBinding } from '../opencode/opencode-structured-account-home'
import { scrubOpenCodeAcpEnvironment } from '../opencode/opencode-acp-environment'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import type { AgentSessionModelOption } from '../../shared/agent-session/agent-session-wire'
import type { AgentChatPermissionMode } from '../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { InitializeResponse } from './generated/acp-protocol.generated'
import { compareAppVersions } from '../../shared/app-version'
import type { ManagedRuntime } from '../node-runtime/managed-runtime-release'
import { readGrokModelCatalog } from './acp-dialects/grok-model-catalog'
import {
  OPENCODE_MODEL_LISTING_ARGS,
  parseOpenCodeModelListing
} from '../opencode/opencode-model-catalog-listing'
import { agentSessionSignInFor } from '../../shared/agent-session/lifecycle/agent-session-sign-in'
import {
  loadGrokVisualsSkill,
  loadOmpVisualsSkill,
  loadOpenCodeVisualsSkill,
  type AcpVisualsSkillLoader
} from './acp-visuals-skill'
import type {
  StructuredAgentSessionHistory,
  StructuredAgentTranscriptImport
} from '../native-chat/structured-agent-cli-conversations'
import { GROK_SESSION_HISTORY } from '../grok/grok-session-history'
import { GROK_TRANSCRIPT_IMPORT } from '../grok/grok-transcript-import'
import { OPENCODE_SESSION_HISTORY } from '../opencode/opencode-session-history'
import { OPENCODE_TRANSCRIPT_IMPORT } from '../opencode/opencode-transcript-import'
import { assertOpenCodeCopyUsesLocalStore } from '../../shared/opencode-launch-command'
import { OMP_SESSION_HISTORY } from '../omp/omp-session-history'
import { OMP_TRANSCRIPT_IMPORT } from '../omp/omp-transcript-import'
import type { AcpSignInWatch } from './acp-agent-connection'
import type { AcpLaunchGate } from './acp-launch-gate'
import { ANTIGRAVITY_LAUNCH_SPEC } from '../antigravity/antigravity-acp-launch-spec'
import type { AgentSessionAccountHome } from '../../shared/agent-session/lifecycle/agent-session-account-home'

/** Model discovery never authenticates interactively. */
export type AcpModelDiscovery =
  | {
      kind: 'initialize'
      read(
        initialized: InitializeResponse,
        connection: {
          requestSessionFreeExtension(method: string, params: unknown): Promise<unknown>
        }
      ): Promise<AgentSessionModelOption[]>
      listingNamesConfiguredModel: boolean
    }
  | {
      kind: 'command'
      args: readonly string[]
      parse(stdout: string): AgentSessionModelOption[]
      listingNamesConfiguredModel: boolean
      /** Unsupported releases use session discovery when enabled, otherwise live-chat catalogs. */
      supportsVersion?(version: string): boolean
      otherReleasesListInSession?: true
    }
  | AcpSessionModelDiscovery
  | { kind: 'unavailable'; reason: string }

/** Requires a chat folder and session deletion or disposable storage to avoid persistent history. */
export type AcpSessionModelDiscovery = {
  kind: 'session'
  listingNamesConfiguredModel: boolean
  sessionFolderArgs?(folder: string): string[]
}

export function acpListingNeedsChatFolder(discovery: AcpModelDiscovery): boolean {
  return (
    discovery.kind === 'session' ||
    (discovery.kind === 'command' && discovery.otherReleasesListInSession === true)
  )
}

export type AcpModelListing = Exclude<AcpModelDiscovery, { kind: 'unavailable' }>

/** Whether `acpModelListingForRelease` needs the installed version. */
export function acpListingDependsOnRelease(discovery: AcpModelDiscovery): boolean {
  return discovery.kind === 'command' && discovery.supportsVersion !== undefined
}

/** How the installed release lists; null when only its chats can. */
export function acpModelListingForRelease(
  discovery: AcpModelDiscovery,
  version: string | null
): AcpModelListing | null {
  if (discovery.kind === 'unavailable') {
    return null
  }
  if (discovery.kind !== 'command' || !discovery.supportsVersion) {
    return discovery
  }
  if (version !== null && discovery.supportsVersion(version)) {
    return discovery
  }
  return discovery.otherReleasesListInSession
    ? { kind: 'session', listingNamesConfiguredModel: discovery.listingNamesConfiguredModel }
    : null
}

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
  launchGate?: AcpLaunchGate
  /** Writes sessions it cannot delete into the user's own history, so it runs no naming tasks. */
  keepsEverySession?: true
  /** A program on the host preferred for new chats; chats whose account home it pins keep it. */
  hostBackend?: AcpHostBackend
}

export type AcpHostBackend = {
  spec: AcpLaunchSpec
  pins(home: AgentSessionAccountHome): boolean
  /** The account home pinning a new chat to `spec`, or null when the host should not run it. */
  select(input: {
    command: string
    env: Record<string, string>
    envToDelete: string[]
    homePath: string
    /** Orca's data folder on this host, where the agent's own account lives. */
    stateDirectory: string
    /** The account type Orca's own Chat signs in with, saved on this host. */
    settings: AcpHostBackendSettings
  }): Promise<AgentSessionAccountHome | null>
}

export type AcpHostBackendSettings = Partial<Pick<GlobalSettings, 'antigravityChatAuth'>>

const GROK_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'grok',
  command: 'grok',
  args: ({ fullAccess, pluginDir }) => [
    'agent',
    ...(fullAccess ? ['--always-approve'] : []),
    ...(pluginDir ? ['--plugin-dir', pluginDir] : []),
    'stdio'
  ],
  env: {},
  dialect: GROK_ACP_DIALECT,
  historyCatchUp: 'prompt-id',
  loginCommand: agentSessionSignInFor('grok')?.loginCommand ?? [],
  // Prefer the launch environment's API key, then cached sign-in; never prompt interactively.
  authMethod: ({ advertised, env }) =>
    env.XAI_API_KEY?.trim() && advertised.includes('xai.api_key')
      ? 'xai.api_key'
      : advertised.includes('cached_token')
        ? 'cached_token'
        : undefined,
  account: directoryAccountBinding('GROK_HOME', (homePath) => join(homePath, '.grok')),
  installDirectories: ({ env }) => (env.GROK_HOME ? [join(env.GROK_HOME, 'bin')] : []),
  // initialize's currentModelId can differ from a session's; leave the default to the chat.
  modelDiscovery: {
    kind: 'initialize',
    read: readGrokModelCatalog,
    listingNamesConfiguredModel: false
  },
  visualsSkill: loadGrokVisualsSkill,
  compaction: true,
  transcriptImport: GROK_TRANSCRIPT_IMPORT,
  sessionHistory: GROK_SESSION_HISTORY
}

// Verified release lines: 1.18.31 recordings and 2.0.14 private-child startup.
const OPENCODE_MINIMUM_VERSIONS = ['1.18.31', '2.0.14'] as const

// 1.x serves in-process; 2.x passes this environment to a private serve --stdio child.
function openCodeLaunchSpec(
  row: Pick<AcpLaunchSpec, 'agent' | 'command' | 'minimumVersions' | 'modelDiscovery'>
): AcpLaunchSpec {
  return {
    ...row,
    // No bypass flag; full access approves permission requests individually.
    args: () => ['acp'],
    // 1.x cannot answer ACP questions; 2.x ignores this guard and negotiates form support.
    env: { OPENCODE_CLIENT: 'acp', OPENCODE_ENABLE_QUESTION_TOOL: 'false' },
    scrubEnvironment: scrubOpenCodeAcpEnvironment,
    dialect: OPENCODE_ACP_DIALECT,
    historyCatchUp: 'user-message-id',
    loginCommand: agentSessionSignInFor(row.agent)?.loginCommand ?? [],
    account: openCodeAcpAccountBinding(),
    installDirectories: ({ homePath }) => [join(homePath, '.opencode', 'bin')],
    visualsSkill: loadOpenCodeVisualsSkill,
    compaction: true,
    assertCopyLaunchArgs: assertOpenCodeCopyUsesLocalStore,
    transcriptImport: OPENCODE_TRANSCRIPT_IMPORT,
    sessionHistory: OPENCODE_SESSION_HISTORY
  }
}

const OPENCODE_LAUNCH_SPEC = openCodeLaunchSpec({
  agent: 'opencode',
  command: 'opencode',
  minimumVersions: OPENCODE_MINIMUM_VERSIONS,
  // 1.x lists via CLI; 2.x requires a disposable session.
  modelDiscovery: {
    kind: 'command',
    args: OPENCODE_MODEL_LISTING_ARGS,
    parse: parseOpenCodeModelListing,
    listingNamesConfiguredModel: false,
    // 2.x and later reject `--verbose`, and their listings omit providers that report after startup.
    supportsVersion: (version) => compareAppVersions(version, '2.0.0') < 0,
    otherReleasesListInSession: true
  }
})

// opencode2 is the installer's 2.x alias; both names share accounts and history.
const OPENCODE2_LAUNCH_SPEC = openCodeLaunchSpec({
  agent: 'opencode2',
  command: 'opencode2',
  minimumVersions: ['2.0.14'],
  modelDiscovery: { kind: 'session', listingNamesConfiguredModel: false }
})

const OMP_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'omp',
  command: 'omp',
  // Full access approves permission requests individually.
  args: ({ pluginDir, model }) => [
    'acp',
    ...(pluginDir ? ['--plugin-dir', pluginDir] : []),
    ...(model ? ['--model', model] : [])
  ],
  // ACP takes listed provider/id values only; the CLI also resolves roles, fallbacks and :level.
  launchesWithModel: true,
  // Answering forms marks the session as having a UI, so `pty: true` bash would open a TUI
  // overlay ACP cannot draw and fail; OMP's own headless modes set this too.
  env: { PI_NO_PTY: '1' },
  dialect: OMP_ACP_DIALECT,
  loginCommand: agentSessionSignInFor('omp')?.loginCommand ?? [],
  account: directoryAccountBinding('PI_CODING_AGENT_DIR', (homePath) =>
    join(homePath, '.omp', 'agent')
  ),
  installDirectories: () => [],
  // First release verified to serve ACP.
  minimumVersions: ['17.0.5'],
  // CLI listings include disabled models; use a disposable session (OMP cannot delete sessions).
  modelDiscovery: {
    kind: 'session',
    listingNamesConfiguredModel: false,
    sessionFolderArgs: (folder) => ['--session-dir', folder]
  },
  visualsSkill: loadOmpVisualsSkill,
  compaction: true,
  compactionInstructions: true,
  transcriptImport: OMP_TRANSCRIPT_IMPORT,
  sessionHistory: OMP_SESSION_HISTORY
}

export const ACP_LAUNCH_SPECS: readonly AcpLaunchSpec[] = [
  GROK_LAUNCH_SPEC,
  OPENCODE_LAUNCH_SPEC,
  OPENCODE2_LAUNCH_SPEC,
  OMP_LAUNCH_SPEC,
  ANTIGRAVITY_LAUNCH_SPEC
]

export function acpLaunchSpecFor(agent: string): AcpLaunchSpec | null {
  return ACP_LAUNCH_SPECS.find((spec) => spec.agent === agent) ?? null
}
