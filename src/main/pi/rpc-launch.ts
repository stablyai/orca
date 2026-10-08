import {
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  ORCA_SCRUB_SAFE_PANE_ENV
} from '../../shared/agent-hook-scrub-safe-env'
import {
  AGENT_HOOK_RUNTIME_ENV_KEYS,
  ORCA_AGENT_SESSION_CALLER_ENV_KEYS
} from '../ipc/pty/host-env/spawn-env-keys'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import { structuredSessionChildIdentityEnv } from '../runtime/structured-session-child-identity-env'

export type PiRpcLaunchOptions = {
  /** Binary and paths are resolved by the execution host before building the launch. */
  command: string
  cwd: string
  fullAccess: boolean
  extraArgs?: readonly string[]
  env?: Record<string, string>
  sessionFile?: string
  forkFile?: string
  structuredSession?: { id: string; spawnToken: string }
}

const CHILD_ENV_TO_DELETE: readonly string[] = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN',
  ORCA_SCRUB_SAFE_PANE_ENV,
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  ...AGENT_HOOK_RUNTIME_ENV_KEYS
]
const CALLER_ENV_TO_DELETE = [
  ...ORCA_AGENT_SESSION_CALLER_ENV_KEYS,
  'ORCA_TERMINAL_HANDLE',
  'ORCA_AGENT_SESSION_SPAWN_TOKEN'
]

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
  const env = { ...options.env }
  for (const key of CALLER_ENV_TO_DELETE) {
    delete env[key]
  }
  const childEnv = options.structuredSession
    ? {
        ...structuredSessionChildIdentityEnv(options.structuredSession.id, env),
        ORCA_AGENT_SESSION_SPAWN_TOKEN: options.structuredSession.spawnToken
      }
    : env
  const args = [...(options.extraArgs ?? [])]
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
      '--mode',
      'rpc',
      ...args,
      ...(options.sessionFile ? ['--session', options.sessionFile] : []),
      ...(options.forkFile ? ['--fork', options.forkFile] : [])
    ],
    env: childEnv,
    envToDelete: [
      ...CHILD_ENV_TO_DELETE,
      ...(options.structuredSession
        ? Object.hasOwn(childEnv, 'ORCA_TERMINAL_HANDLE')
          ? []
          : ['ORCA_TERMINAL_HANDLE']
        : CALLER_ENV_TO_DELETE)
    ]
  }
}
