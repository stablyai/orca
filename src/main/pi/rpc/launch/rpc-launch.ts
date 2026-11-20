import { ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV } from '../../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { ORCA_AGENT_SESSION_CALLER_ENV_KEYS } from '../../../ipc/pty/host-env/spawn-env-keys'
import { STRUCTURED_CHILD_ENV_TO_DELETE } from '../../../runtime/agent-session/environment/structured-session-child-env'
import {
  LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV,
  NATIVE_CHAT_SCRATCH_DIR_ENV
} from '../../../native-chat/conversation-files/native-chat-visuals-delivery'
import type { ProviderProcessLaunch } from '../../../provider-process/provider-process-launch'
import type { ReadOnlySessionMode } from '../../../bots/bot-look-around-policy'
import { compareAppVersions } from '../../../../shared/app-lifecycle/identity/app-version'
import type { AgentCliVersionCheck } from '../../../agent-launch/preflight/agent-cli-version-probe'
import { AgentCliInstallationError } from '../../../native-chat/agent-launch/agent-cli-installation-error'
import type { PiBackgroundWorkLaunch } from '../background-work/rpc-background-work-bridge'
import { PI_BACKGROUND_WORK_DIR_ENV } from '../background-work/rpc-background-work-bridge-source'
import { PI_BOT_TOOLS_ENV } from '../../../bots/bot-tools-pi'

export type PiRpcLaunchOptions = {
  command: string
  prefixArgs?: readonly string[]
  cwd: string
  fullAccess: boolean
  extraArgs?: readonly string[]
  env?: Record<string, string>
  envToDelete?: readonly string[]
  sessionFile?: string
  forkFile?: string
  /** Appended to Pi's own system prompt; a path keeps the text clear of argument-length limits. */
  instructionsFile?: string
  /** Skill folders loaded beside Pi's own. */
  skillDirs?: readonly string[]
  /** Absent: every tool Pi has. */
  tools?: PiToolLimit
  /** Orca's background-work bridge for this launch; absent when it could not be prepared. */
  backgroundWork?: PiBackgroundWorkLaunch
  /** The extension that registers a bot's own tools, and the servers it reads; absent: none. */
  botTools?: { extension: string; servers: string }
}

const CALLER_ENV_TO_DELETE = [
  ...ORCA_AGENT_SESSION_CALLER_ENV_KEYS,
  'ORCA_TERMINAL_HANDLE',
  ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV
]

/** Structured Pi has no scratch folder; an inherited one belongs to another chat. */
export const PI_RPC_SESSION_ENV_TO_DELETE: readonly string[] = [
  NATIVE_CHAT_SCRATCH_DIR_ENV,
  LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV
]

/** Remove caller identity before the structured-session seal supplies its own. */
export function withoutPiCallerEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const next = { ...env }
  for (const key of CALLER_ENV_TO_DELETE) {
    delete next[key]
  }
  return next
}

/** Catalog probes run outside a structured session and inherit no caller identity. */
export function piRpcSessionlessEnvironment(env: Readonly<Record<string, string>>): {
  env: Record<string, string>
  envToDelete: readonly string[]
} {
  return {
    env: withoutPiCallerEnv(env),
    envToDelete: [...new Set([...STRUCTURED_CHILD_ENV_TO_DELETE, ...CALLER_ENV_TO_DELETE])]
  }
}

const PI_READ_TOOLS = ['read', 'grep', 'find', 'ls'] as const
// A limited run is refused any other tool selection, which could widen it.
const PI_TOOL_SELECTION_FLAGS = [
  '--tools',
  '-t',
  '--no-tools',
  '-nt',
  '--no-builtin-tools',
  '-nbt',
  '--exclude-tools',
  '-xt',
  '--no-mcp'
]

export type PiToolLimit = 'read' | 'none'

// A run limited to some tools also turns MCP off, which --no-mcp does from Pi 1.0.4.
const PI_LIMITED_TOOLS_MINIMUM_VERSION = '1.0.4'

/** A look reads only; a reply-only run has no tools. Null runs every tool Pi has. */
export function piToolLimit(
  readOnly: ReadOnlySessionMode | null,
  launchVersion: AgentCliVersionCheck
): PiToolLimit | null {
  const tools = readOnly === 'reply-only' ? 'none' : readOnly ? 'read' : null
  if (
    tools &&
    launchVersion.status === 'ready' &&
    compareAppVersions(launchVersion.version, PI_LIMITED_TOOLS_MINIMUM_VERSION) < 0
  ) {
    throw AgentCliInstallationError.tooOld('pi', {
      version: launchVersion.version,
      minimumVersion: PI_LIMITED_TOOLS_MINIMUM_VERSION
    })
  }
  return tools
}

/** Pi stores its own sessions; an explicit session file is shared with terminal resumes. */
export function buildPiRpcLaunch(options: PiRpcLaunchOptions): ProviderProcessLaunch {
  if (!options.fullAccess) {
    throw new Error('Pi structured chat supports full access only')
  }
  if (options.sessionFile !== undefined && !options.sessionFile.trim()) {
    throw new Error('Pi resume requires a session file')
  }
  if (
    options.forkFile !== undefined &&
    (!options.forkFile.trim() || options.sessionFile !== undefined)
  ) {
    throw new Error('Pi fork requires one source session file')
  }
  const args = [...(options.extraArgs ?? [])]
  const selection =
    options.tools &&
    [...(options.prefixArgs ?? []), ...args].find((arg) =>
      PI_TOOL_SELECTION_FLAGS.includes(arg.split('=')[0])
    )
  if (selection) {
    throw new Error(`Pi ${selection.split('=')[0]} conflicts with a limited tool launch`)
  }
  let provider = false
  let model = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    const flag = arg.split('=')[0]
    if (flag === '--provider' || flag === '--model' || flag === '-m') {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++index]
      if (!value || value.startsWith('-')) {
        throw new Error(`Pi ${flag} requires a value`)
      }
      if (flag === '--provider') {
        provider = true
      } else {
        model = true
      }
    } else if (
      [
        '--mode',
        '--print',
        '-p',
        '--no-session',
        '--session',
        '-r',
        '--resume',
        '-c',
        '--continue',
        '--fork'
      ].includes(flag)
    ) {
      throw new Error(`Pi ${flag} conflicts with the structured chat launch`)
    }
  }
  if (provider && !model) {
    throw new Error('Pi --provider requires --model')
  }
  return {
    command: options.command,
    cwd: options.cwd,
    args: [
      ...(options.prefixArgs ?? []),
      '--mode',
      'rpc',
      ...args,
      ...(options.instructionsFile ? ['--append-system-prompt', options.instructionsFile] : []),
      ...(options.skillDirs ?? []).flatMap((dir) => ['--skill', dir]),
      // Plain names replace the whole selection, a resumed session's included, and leave MCP tools undeclared.
      ...(options.tools === 'read' ? ['--tools', PI_READ_TOOLS.join(','), '--no-mcp'] : []),
      ...(options.tools === 'none' ? ['--no-tools', '--no-mcp'] : []),
      ...(options.backgroundWork ? ['--extension', options.backgroundWork.extension] : []),
      ...(options.botTools ? ['--extension', options.botTools.extension] : []),
      ...(options.sessionFile ? ['--session', options.sessionFile] : []),
      ...(options.forkFile ? ['--fork', options.forkFile] : [])
    ],
    env: {
      ...options.env,
      ...(options.backgroundWork
        ? { [PI_BACKGROUND_WORK_DIR_ENV]: options.backgroundWork.directory }
        : {}),
      ...(options.botTools ? { [PI_BOT_TOOLS_ENV]: options.botTools.servers } : {})
    },
    envToDelete: [...(options.envToDelete ?? [])]
  }
}
