// How Orca starts each ACP agent, as data: adding an agent is one more row (plus a dialect when it
// speaks protocol extensions). Nothing outside `acp-dialects/` branches on an agent's name.

import { join } from 'node:path'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'
import { OMP_ACP_DIALECT } from './acp-dialects/omp-dialect'
import { OPENCODE_ACP_DIALECT } from './acp-dialects/opencode-dialect'
import { ANTIGRAVITY_ACP_DIALECT } from './acp-dialects/antigravity-dialect'
import { directoryAccountBinding, type AcpAccountBinding } from './acp-account-binding'
import { openCodeAcpAccountBinding } from '../opencode/opencode-structured-account-home'
import { scrubOpenCodeAcpEnvironment } from '../opencode/opencode-acp-environment'
import { openCodeStoredUserMessagesReader } from '../opencode/opencode-acp-stored-messages'
import type { AcpStoredUserMessagesReader } from './acp-recovery-history'
import type { TuiAgent } from '../../shared/tui-agent'
import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import type { AgentChatPermissionMode } from '../../shared/agent-chat-permission-mode'
import type { InitializeResponse } from './generated/acp-protocol.generated'
import { compareAppVersions } from '../../shared/app-version'
import type { ManagedRuntime } from '../node-runtime/managed-runtime-release'
import { readGrokModelCatalog } from './acp-dialects/grok-model-catalog'
import {
  OPENCODE_MODEL_LISTING_ARGS,
  parseOpenCodeModelListing
} from '../opencode/opencode-model-catalog-listing'
import { agentSessionSignInFor } from '../../shared/agent-session-sign-in'
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
import {
  ANTIGRAVITY_ACP_COMMAND,
  ANTIGRAVITY_ACP_RUNTIME
} from '../antigravity/antigravity-acp-runtime'
import {
  ANTIGRAVITY_ACP_ENV,
  scrubAntigravityAcpEnvironment
} from '../antigravity/antigravity-acp-environment'
import {
  ANTIGRAVITY_LAUNCH_GATE,
  answerAntigravityChatAuth,
  antigravityChatAccount
} from '../antigravity/antigravity-chat-account'
import { readAntigravitySignInLine } from '../antigravity/antigravity-sign-in-url'
import type { AcpSignInWatch } from './acp-agent-connection'
import type { AcpLaunchGate } from './acp-launch-gate'

/** How an agent lists its models before a chat: from its `initialize` answer (plus extension
 *  requests), from a listing command, from a session it opens and deletes, or not at all. Never
 *  `authenticate`. */
export type AcpModelDiscovery =
  | {
      kind: 'initialize'
      read(
        initialized: InitializeResponse,
        connection: {
          requestSessionFreeExtension(method: string, params: unknown): Promise<unknown>
        }
      ): Promise<AgentSessionModelOption[]>
      /** The listing marks the model the account is configured to run as its default. */
      listingNamesConfiguredModel: boolean
    }
  | {
      kind: 'command'
      args: readonly string[]
      parse(stdout: string): AgentSessionModelOption[]
      listingNamesConfiguredModel: boolean
      /** The releases whose listing matches what their chats offer; any other lists in a session
       *  when `otherReleasesListInSession`, else not at all and its chats' own lists fill the
       *  catalog. Absent lists on every release. */
      supportsVersion?(version: string): boolean
      otherReleasesListInSession?: true
    }
  | AcpSessionModelDiscovery
  | { kind: 'unavailable'; reason: string }

/** What a new chat offers, read from a session opened in the asking chat's folder and then
 *  deleted. An agent that cannot delete one is not asked unless it can keep that session in a
 *  folder Orca removes, and with no chat folder (a prewarm) none is opened, so no conversation or
 *  new project is left in its history. */
export type AcpSessionModelDiscovery = {
  kind: 'session'
  listingNamesConfiguredModel: boolean
  /** Arguments that keep the listing's session in `folder` instead of the agent's own store. */
  sessionFolderArgs?(folder: string): string[]
}

/** Whether some release lists in a session in the asking chat's folder, so the listing needs one
 *  and reads that folder's project config. */
export function acpListingNeedsChatFolder(discovery: AcpModelDiscovery): boolean {
  return (
    discovery.kind === 'session' ||
    (discovery.kind === 'command' && discovery.otherReleasesListInSession === true)
  )
}

export type AcpLaunchSpec = {
  /** The Orca agent id, which names the agent's records, its catalog label and its settings. */
  agent: TuiAgent
  command: string
  /** The terminal agent's Command setting may name a different program than this chat server. */
  ignoreAgentCommandSetting?: true
  /** Built per launch: `fullAccess` is the chat's own Full access permission mode;
   *  `pluginDir` is a plugin folder `visualsSkill` asked the agent to load. */
  args(input: { fullAccess: boolean; pluginDir: string | null }): string[]
  /** Laid over the child's environment last, after the account and the user's own variables. */
  env: Readonly<Record<string, string>>
  /** Rewrites what the child would inherit from Orca's own plumbing; returns the keys it must not
   *  inherit at all. `inherited` is the environment the child process starts from. */
  scrubEnvironment?(env: Record<string, string>, inherited: NodeJS.ProcessEnv): string[]
  dialect: AcpDialect
  /** The agent's own sign-in command, for a person to run when it reports auth required. */
  loginCommand: readonly string[]
  /** Which advertised sign-in method to use when the agent reports auth required, read from the
   *  environment it was launched with (on its own machine); none leaves it not signed in. */
  authMethod?(input: {
    advertised: readonly string[]
    env: Readonly<Record<string, string>>
  }): string | undefined
  /** The agent's browser sign-in on its output: a valid sign-in line ends the chat signed out. */
  signIn?: Omit<AcpSignInWatch, 'link'>
  /** The account each chat pins, and how a launch points the agent at it. */
  account: AcpAccountBinding
  /** The ascending `--version` minimums a structured chat needs (`agentCliMinimumVersion`), asked
   *  before a create and again at every launch; absent runs whatever is installed. */
  minimumVersions?: readonly string[]
  /** Where the agent installs its own binary, searched after PATH. */
  installDirectories(input: { env: Readonly<Record<string, string>>; homePath: string }): string[]
  /** A pinned copy Orca installs under its data folder when the person asks; a start runs an
   *  installed release before PATH and never installs one. A spec with one names no
   *  `minimumVersions`. */
  managedRuntime?: ManagedRuntime
  /** The agent's `mode` config option value per chat permission mode, through which it enforces
   *  the mode itself; Orca then answers none of its permission requests for the person. */
  permissionModeConfig?: {
    values: { ask: string } & Partial<Record<AgentChatPermissionMode, string>>
  }
  /** The agent compacts its conversation when sent `/compact` as a prompt; off hides `/compact`. */
  compaction?: true
  /** Throws when the chat's own arguments would send a copied conversation's CLI elsewhere than
   *  the store the copy is written to. */
  assertCopyLaunchArgs?: (args: readonly string[]) => void
  /** The agent's own store of a session's user messages, read for restart recovery only. */
  readStoredUserMessages?: AcpStoredUserMessagesReader
  modelDiscovery: AcpModelDiscovery
  /** How a launch loads the inline-visuals skill; absent, the agent's chats have no visuals. */
  visualsSkill?: AcpVisualsSkillLoader
  /** How a chat adopts a conversation the agent's CLI recorded; null when it cannot. */
  transcriptImport: StructuredAgentTranscriptImport | null
  /** How the agent's chats own the Session History rows their conversations list as. */
  sessionHistory: StructuredAgentSessionHistory
  /** Each process gets its own temp folder: the agent's temp files collide across processes. */
  privateTempDirectory?: true
  /** Reopens a chat's session with `session/resume` even when the agent can also load it. */
  resumePreference?: 'resume'
  /** Holds this host's chat starts off while its sign-in or runtime is replaced or removed. */
  launchGate?: AcpLaunchGate
}

const GROK_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'grok',
  command: 'grok',
  // `--always-approve` only for full access, as the chat's permission mode chooses.
  args: ({ fullAccess, pluginDir }) => [
    'agent',
    ...(fullAccess ? ['--always-approve'] : []),
    ...(pluginDir ? ['--plugin-dir', pluginDir] : []),
    'stdio'
  ],
  env: {},
  dialect: GROK_ACP_DIALECT,
  loginCommand: agentSessionSignInFor('grok')?.loginCommand ?? [],
  // An API key in Grok's own environment, else the sign-in Grok already cached; never interactive.
  authMethod: ({ advertised, env }) =>
    env.XAI_API_KEY?.trim() && advertised.includes('xai.api_key')
      ? 'xai.api_key'
      : advertised.includes('cached_token')
        ? 'cached_token'
        : undefined,
  account: directoryAccountBinding('GROK_HOME', (homePath) => join(homePath, '.grok')),
  installDirectories: ({ env }) => (env.GROK_HOME ? [join(env.GROK_HOME, 'bin')] : []),
  // Grok lists its models in `initialize`, before and without any session. Its `currentModelId`
  // there can differ from what a session runs, so a chat started with no pick names the default.
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

// 1.18.31 is the release the recorded sessions capture; 2.0.14 the 2.x release verified to start the
// private child below.
const OPENCODE_MINIMUM_VERSIONS = ['1.18.31', '2.0.14'] as const

// `opencode acp` on 1.x serves in-process; on 2.x it starts a private `opencode serve --stdio` child
// with this environment and ends it with stdin, so both lines run the chat's own account.
function openCodeLaunchSpec(
  row: Pick<AcpLaunchSpec, 'agent' | 'command' | 'minimumVersions' | 'modelDiscovery'>
): AcpLaunchSpec {
  return {
    ...row,
    // OpenCode has no bypass flag: full access answers each permission request yes.
    args: () => ['acp'],
    // Applied last: the client name ACP sessions report, and no question tool, since Orca shows no
    // question form yet (1.x would wait on one forever; 2.x drops it).
    env: { OPENCODE_CLIENT: 'acp', OPENCODE_ENABLE_QUESTION_TOOL: 'false' },
    scrubEnvironment: scrubOpenCodeAcpEnvironment,
    dialect: OPENCODE_ACP_DIALECT,
    loginCommand: agentSessionSignInFor(row.agent)?.loginCommand ?? [],
    account: openCodeAcpAccountBinding(),
    installDirectories: ({ homePath }) => [join(homePath, '.opencode', 'bin')],
    readStoredUserMessages: openCodeStoredUserMessagesReader(),
    visualsSkill: loadOpenCodeVisualsSkill,
    compaction: true,
    assertCopyLaunchArgs: assertOpenCodeCopyUsesLocalStore,
    // Finds a conversation of either line in the one database both lines write.
    transcriptImport: OPENCODE_TRANSCRIPT_IMPORT,
    sessionHistory: OPENCODE_SESSION_HISTORY
  }
}

const OPENCODE_LAUNCH_SPEC = openCodeLaunchSpec({
  agent: 'opencode',
  command: 'opencode',
  minimumVersions: OPENCODE_MINIMUM_VERSIONS,
  // Its `initialize` names no models; 1.x lists them with a command, 2.x in a session it deletes.
  modelDiscovery: {
    kind: 'command',
    args: OPENCODE_MODEL_LISTING_ARGS,
    parse: parseOpenCodeModelListing,
    // The listing marks no default; a chat started with no pick names it.
    listingNamesConfiguredModel: false,
    // 2.x and later reject `--verbose`, and their listings omit providers that report after startup.
    supportsVersion: (version) => compareAppVersions(version, '2.0.0') < 0,
    otherReleasesListInSession: true
  }
})

// Since 2.0.0 `opencode2` is an alias OpenCode's installer writes beside `opencode`, and the only
// name for 2.x where `opencode` is still 1.x. Its chats share OpenCode's account and history rows.
const OPENCODE2_LAUNCH_SPEC = openCodeLaunchSpec({
  agent: 'opencode2',
  command: 'opencode2',
  minimumVersions: ['2.0.14'],
  modelDiscovery: { kind: 'session', listingNamesConfiguredModel: false }
})

// OMP serves ACP through `omp acp`; its environment reaches it as the user set it.
const OMP_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'omp',
  command: 'omp',
  // Full access answers each permission request yes.
  args: ({ pluginDir }) => ['acp', ...(pluginDir ? ['--plugin-dir', pluginDir] : [])],
  env: {},
  dialect: OMP_ACP_DIALECT,
  loginCommand: agentSessionSignInFor('omp')?.loginCommand ?? [],
  // The directory OMP's terminal chats read too; its default is OMP's own.
  account: directoryAccountBinding('PI_CODING_AGENT_DIR', (homePath) =>
    join(homePath, '.omp', 'agent')
  ),
  // OMP's installers use directories the shared resolver already searches after PATH.
  installDirectories: () => [],
  // 17.0.5 is the release verified to serve `omp acp`.
  minimumVersions: ['17.0.5'],
  // `omp models --json` lists every model without the `enabledModels` filter a chat applies, so it
  // could offer models a chat refuses. A session lists exactly what a chat in that folder offers;
  // `omp acp` cannot delete one, so it is kept out of OMP's store (17.0.5 and 18.12.2 verified).
  modelDiscovery: {
    kind: 'session',
    listingNamesConfiguredModel: false,
    sessionFolderArgs: (folder) => ['--session-dir', folder]
  },
  visualsSkill: loadOmpVisualsSkill,
  compaction: true,
  transcriptImport: OMP_TRANSCRIPT_IMPORT,
  sessionHistory: OMP_SESSION_HISTORY
}

// `agy` keeps its own conversations apart from the ACP server's, so its arguments resume none.
const ANTIGRAVITY_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['antigravity'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: () => null
}

// Google's Antigravity ACP server, which Orca installs (the `agy` CLI has no ACP mode). Its chats
// sign in to a folder of their own on each host; an `agy` login is not theirs.
export const ANTIGRAVITY_LAUNCH_SPEC = {
  agent: 'antigravity',
  command: ANTIGRAVITY_ACP_COMMAND,
  ignoreAgentCommandSetting: true,
  // The registry's Linux launch: without `--uid=` the server, started as root, drops to nobody.
  args: () => (process.platform === 'linux' ? ['--uid='] : []),
  env: ANTIGRAVITY_ACP_ENV,
  scrubEnvironment: scrubAntigravityAcpEnvironment,
  dialect: ANTIGRAVITY_ACP_DIALECT,
  loginCommand: agentSessionSignInFor('antigravity')?.loginCommand ?? [],
  // Signs in with the Google account the folder saved; without one, the server prints a sign-in link.
  authMethod: ({ advertised }) =>
    advertised.includes('oauth-personal') ? 'oauth-personal' : undefined,
  signIn: {
    read: readAntigravitySignInLine,
    // The host's sign-in status is the server's latest answer, as chats meet it.
    answered: answerAntigravityChatAuth
  },
  account: antigravityChatAccount,
  installDirectories: () => [],
  managedRuntime: ANTIGRAVITY_ACP_RUNTIME,
  // Its yolo mode still asks the person questions and administrative reviews.
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
