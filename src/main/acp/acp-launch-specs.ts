// How Orca starts each ACP agent, as data: adding an agent is one more row (plus a dialect when it
// speaks protocol extensions). Nothing outside `acp-dialects/` branches on an agent's name.

import { join } from 'node:path'
import {
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  ORCA_SCRUB_SAFE_PANE_ENV
} from '../../shared/agent-hook-scrub-safe-env'
import { AGENT_HOOK_RUNTIME_ENV_KEYS } from '../ipc/pty/host-env/spawn-env-keys'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'
import { OMP_ACP_DIALECT } from './acp-dialects/omp-dialect'
import { OPENCODE_ACP_DIALECT } from './acp-dialects/opencode-dialect'
import { directoryAccountBinding, type AcpAccountBinding } from './acp-account-binding'
import { openCodeAcpAccountBinding } from '../opencode/opencode-structured-account-home'
import { scrubOpenCodeAcpEnvironment } from '../opencode/opencode-acp-environment'
import { openCodeStoredUserMessagesReader } from '../opencode/opencode-acp-stored-messages'
import type { AcpStoredUserMessagesReader } from './acp-recovery-history'
import { isStableCliVersionFrom, isStableCliVersionOnLine } from '../agent-cli-version-probe'
import type { TuiAgent } from '../../shared/tui-agent'

export type AcpLaunchSpec = {
  /** The Orca agent id, which names the agent's records, its catalog label and its settings. */
  agent: TuiAgent
  command: string
  /** Built per launch: `fullAccess` is the Agent Permissions setting's bypass posture. */
  args(input: { fullAccess: boolean }): string[]
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
  /** The account each chat pins, and how a launch points the agent at it. */
  account: AcpAccountBinding
  /** The `--version` releases a structured chat runs on, asked before a create and again at every
   *  launch; any other release keeps the terminal chat. Absent runs whatever is installed. */
  supportsVersion?(version: string): boolean
  /** Where the agent installs its own binary, searched after PATH. */
  installDirectories(input: { env: Readonly<Record<string, string>>; homePath: string }): string[]
  /** Images go to the agent when it also advertises them; off sends text prompts only. */
  imagePrompts?: true
  /** The agent's own store of a session's user messages, read for restart recovery only. */
  readStoredUserMessages?: AcpStoredUserMessagesReader
}

const GROK_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'grok',
  command: 'grok',
  // `--always-approve` only for full access, as the user's setting chooses.
  args: ({ fullAccess }) => ['agent', ...(fullAccess ? ['--always-approve'] : []), 'stdio'],
  env: {},
  dialect: GROK_ACP_DIALECT,
  loginCommand: ['grok', 'login'],
  // An API key in Grok's own environment, else the sign-in Grok already cached; never interactive.
  authMethod: ({ advertised, env }) =>
    env.XAI_API_KEY?.trim() && advertised.includes('xai.api_key')
      ? 'xai.api_key'
      : advertised.includes('cached_token')
        ? 'cached_token'
        : undefined,
  account: directoryAccountBinding('GROK_HOME', (homePath) => join(homePath, '.grok')),
  installDirectories: ({ env }) => (env.GROK_HOME ? [join(env.GROK_HOME, 'bin')] : [])
}

// `opencode acp` on 1.x serves in-process; on 2.x it starts a private `opencode serve --stdio` child
// with this environment and ends it with stdin, so both lines run the chat's own account.
const OPENCODE_ACP_RELEASE_LINES = [
  // The release the recorded sessions capture.
  { major: 1, floor: '1.18.31' },
  // The 2.x release verified to start that private child.
  { major: 2, floor: '2.0.14' }
] as const

const OPENCODE_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'opencode',
  command: 'opencode',
  // OpenCode has no bypass flag: full access answers each permission request yes.
  args: () => ['acp'],
  // Applied last: the client name ACP sessions report, and no question tool, which ACP cannot
  // answer (it would wait forever).
  env: { OPENCODE_CLIENT: 'acp', OPENCODE_ENABLE_QUESTION_TOOL: 'false' },
  scrubEnvironment: scrubOpenCodeAcpEnvironment,
  dialect: OPENCODE_ACP_DIALECT,
  loginCommand: ['opencode', 'auth', 'login'],
  account: openCodeAcpAccountBinding(),
  installDirectories: ({ homePath }) => [join(homePath, '.opencode', 'bin')],
  supportsVersion: (version) =>
    OPENCODE_ACP_RELEASE_LINES.some((line) => isStableCliVersionOnLine(version, line)),
  imagePrompts: true,
  readStoredUserMessages: openCodeStoredUserMessagesReader()
}

// OMP serves ACP through `omp acp`; its environment reaches it as the user set it.
const OMP_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'omp',
  command: 'omp',
  // `omp acp` takes no flags: full access answers each permission request yes.
  args: () => ['acp'],
  env: {},
  dialect: OMP_ACP_DIALECT,
  // OMP signs in from its own `/login`.
  loginCommand: ['omp'],
  // The directory OMP's terminal chats read too; its default is OMP's own.
  account: directoryAccountBinding('PI_CODING_AGENT_DIR', (homePath) =>
    join(homePath, '.omp', 'agent')
  ),
  // OMP's installers use directories the shared resolver already searches after PATH.
  installDirectories: () => [],
  // Stable releases from 17.0.5, the release verified to serve `omp acp`.
  supportsVersion: (version) => isStableCliVersionFrom(version, '17.0.5')
}

export const ACP_LAUNCH_SPECS: readonly AcpLaunchSpec[] = [
  GROK_LAUNCH_SPEC,
  OPENCODE_LAUNCH_SPEC,
  OMP_LAUNCH_SPEC
]

export function acpLaunchSpecFor(agent: string): AcpLaunchSpec | null {
  return ACP_LAUNCH_SPECS.find((spec) => spec.agent === agent) ?? null
}

/**
 * A pane's identity in the inherited environment would let the agent's own Orca status hooks
 * report for this session too; the structured session is its one status producer.
 */
export const ACP_CHILD_ENV_TO_DELETE: readonly string[] = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN',
  ORCA_SCRUB_SAFE_PANE_ENV,
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  ...AGENT_HOOK_RUNTIME_ENV_KEYS
]
