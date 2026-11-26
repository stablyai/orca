import { resolveLoginShellEnvironment } from '../startup/shell-environment/login-shell-environment'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { detectWslCommandsOnPath } from '../ipc/preflight/preflight-wsl-agent-detection'
import { detectCommandsInInstallDirs } from '../../shared/agent-launch/installation/local-agent-install-dir-detection'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight/preflight-runtime-target'
import {
  findCommandsOnLocalPath,
  type AgentPathMatch
} from '../ipc/command-path/command-path-batch'
import { buildLocalPreflightEnv } from '../ipc/preflight/preflight-local-env'
import { hasPathSeparatorToken } from '../../shared/agent-launch/installation/managed-agent-command-token'
import { isOrcaAgentRuntimePath } from '../managed-agent-cli/managed-agent-cli-path'
import {
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  getTuiAgentDetectionProbeCommands
} from '../../shared/agent-launch/catalog/tui-agent-detection-commands'
import { stockLaunchProgram } from '../../shared/agent-launch/startup/managed-agent-launch-program'
import { TUI_AGENT_CONFIG, isTuiAgent } from '../../shared/agent-launch/catalog/tui-agent-config'
import { hasAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import type { AgentStartupShell } from '../../shared/agent-launch/startup/tui-agent-startup-shell'

type CommandInventory = {
  found: Set<string>
  matches: Map<string, AgentPathMatch>
  probed: ReadonlySet<string>
}

type LocalInventory = { pending?: Promise<CommandInventory>; current?: CommandInventory }
let local: LocalInventory = {}
let profile: string | undefined

function localInventory(): LocalInventory {
  const key = hasAppEnvironment() ? getProfileUserDataPath() : undefined
  if (key !== profile) {
    local = {}
    profile = key
  }
  return local
}

const stockCommands = [
  ...getTuiAgentDetectionProbeCommands(KNOWN_TUI_AGENT_DETECTION_COMMANDS, process.platform),
  ...Object.keys(TUI_AGENT_CONFIG)
    .filter(isTuiAgent)
    .map((agent) => stockLaunchProgram(agent, process.platform))
]

async function scanLocalInventory(
  probed: ReadonlySet<string>,
  readLoginPath: boolean
): Promise<CommandInventory> {
  const localEnv = buildLocalPreflightEnv()
  const env = localEnv ?? (readLoginPath ? await resolveLoginShellEnvironment() : process.env)
  const pathEnv = env.PATH ?? Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1]
  const matches = new Map<string, AgentPathMatch>()
  const found = await findCommandsOnLocalPath([...probed], {
    env,
    inventory: { isRuntimePath: isOrcaAgentRuntimePath, matches }
  })
  const installs = await detectCommandsInInstallDirs(
    [...probed].filter((cmd) => !found.has(cmd) && !hasPathSeparatorToken(cmd)),
    pathEnv,
    { skipPathSearch: true }
  )
  for (const [command, user] of installs) {
    if (!isOrcaAgentRuntimePath(user)) {
      matches.set(command, { ...matches.get(command), user })
      found.add(command)
    }
  }
  return { matches, found, probed }
}

function startLocalInventory(
  extraCommands: readonly string[],
  refresh: boolean,
  readLoginPath = false
): Promise<CommandInventory> {
  const slot = localInventory()
  if (slot.pending) {
    return slot.pending
  }
  if (
    !refresh &&
    slot.current &&
    extraCommands.every((command) => slot.current?.probed.has(command))
  ) {
    return Promise.resolve(slot.current)
  }
  const probed = new Set([...stockCommands, ...extraCommands])
  const pending = scanLocalInventory(probed, readLoginPath)
    .then((result) => {
      if (slot === localInventory() && slot.pending === pending) {
        slot.current = result
      }
      return result
    })
    .finally(() => {
      if (slot.pending === pending) {
        delete slot.pending
      }
    })
  slot.pending = pending
  return pending
}

export type TerminalAgentProgram =
  | { kind: 'by-name' | 'full-path'; path: string }
  | { kind: 'unavailable' | 'unknown' }

function qualifyProgram(
  match: AgentPathMatch | undefined,
  shell: AgentStartupShell
): TerminalAgentProgram {
  if (!match?.user) {
    return { kind: 'unavailable' }
  }
  const winner = shell === 'powershell' ? match.unquoted : match.first
  return winner && !isOrcaAgentRuntimePath(winner)
    ? { kind: 'by-name', path: winner }
    : { kind: 'full-path', path: match.user }
}

export async function readLocalTerminalAgentProgram(
  program: string,
  shell: AgentStartupShell,
  refresh = false
): Promise<TerminalAgentProgram> {
  const slot = localInventory()
  const inventory = await startLocalInventory([program], refresh, true)
  return slot === localInventory() && inventory.probed.has(program)
    ? qualifyProgram(inventory.matches.get(program), shell)
    : { kind: 'unknown' }
}

export async function detectAgentCommandsOnHost(
  commands: readonly string[],
  options: {
    connectionId?: string | null
    context?: PreflightRuntimeContext
    outsidePath?: Map<string, string>
  } = {}
): Promise<Set<string>> {
  if (options.connectionId) {
    throw new SshHostNotServedError(options.connectionId)
  }
  const wslTarget = getPreflightWslTarget(options.context)
  if (wslTarget) {
    return detectWslCommandsOnPath(wslTarget, commands)
  }
  const { found, matches, probed } = await startLocalInventory(commands, true)
  const shell = process.platform === 'win32' ? 'powershell' : 'posix'
  const unprobed = commands.filter((command) => !probed.has(command))
  const additional = unprobed.length ? await startLocalInventory(commands, true) : undefined
  return new Set(
    commands.filter((command) => {
      const result = additional && !probed.has(command) ? additional : { found, matches }
      const program = qualifyProgram(result.matches.get(command), shell)
      if (program.kind === 'full-path') {
        options.outsidePath?.set(command, program.path)
      }
      return result.found.has(command)
    })
  )
}
