import { delimiter, isAbsolute, resolve } from 'node:path'
import {
  replaceLaunchExecutable,
  stockLaunchProgram
} from '../../shared/agent-launch/startup/managed-agent-launch-program'
import {
  isFreshOmpLaunchCommand,
  prepareFreshOmpLaunch
} from '../../shared/agent-launch/startup/omp-fresh-launch'
import { readLaunchPosition } from '../../shared/agent-launch/startup/launch-position'
import { COMMAND_TOKEN_SCAN_MAX_CHARS } from '../../shared/shell/command-resolution/command-token-scanner'
import type { AgentStartupShell } from '../../shared/agent-launch/startup/tui-agent-startup-shell'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../shared/agent-launch/catalog/tui-agent-config'
import {
  msysDrivePathToWindows,
  normalizeRuntimePathForComparison
} from '../../shared/file-access/cross-platform-path'
import { normalizePathEntry } from '../../shared/shell/command-resolution/node-cli-command-resolution'
import { resolveWindowsGitBashShellPathAsync } from '../pty/shell-startup/git-bash'
import { resolveLoginShellEnvironment } from '../startup/shell-environment/login-shell-environment'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { readHostManagedAgentCommands } from '../runtime/rpc/methods/host-management/managed-copy-detection'
import { MANAGED_AGENT_CLI_IDS, managedAgentCli } from './managed-agent-cli-registry'

type SpawnSettings = Parameters<typeof readHostManagedAgentCommands>[0]

const stockAgents = new Map<string, TuiAgent>()
for (const agent of Object.keys(TUI_AGENT_CONFIG).filter(isTuiAgent)) {
  const program = stockLaunchProgram(agent, process.platform)
  if (!stockAgents.has(program)) {
    stockAgents.set(program, agent)
  }
}
const stockPrograms = [...stockAgents.keys()]

type SpawnLaunch = {
  launchCommand: string | undefined
  codexRuntime?: 'host' | 'wsl'
  getSettings?: () => SpawnSettings | undefined
  cwd?: string
  env?: Record<string, string | undefined>
  envToDelete?: readonly string[]
  shellOverride?: string
}

function managedPathAgent(program: string): TuiAgent | undefined {
  if (!isAbsolute(program) || !/[\\/]agent-runtimes[\\/]/i.test(program)) {
    return undefined
  }
  const dataDirectory = getProfileUserDataPath()
  return MANAGED_AGENT_CLI_IDS.find((agent) => {
    const cli = managedAgentCli(agent)
    const root = cli.runtime.root(dataDirectory)
    const prefix = program.slice(0, root.length)
    if (normalizeRuntimePathForComparison(prefix) !== normalizeRuntimePathForComparison(root)) {
      return false
    }
    const release = /^[\\/][^\\/]+(?=[\\/])/.exec(program.slice(root.length))?.[0]
    if (!release) {
      return false
    }
    const folder = prefix + release
    const actual = normalizeRuntimePathForComparison(program)
    return (
      actual === normalizeRuntimePathForComparison(cli.executable(folder)) ||
      (cli.launcher !== undefined &&
        actual === normalizeRuntimePathForComparison(cli.launcher(folder)))
    )
  })
}

function launchPath(env: NodeJS.ProcessEnv): string | undefined {
  if (process.platform !== 'win32') {
    return env.PATH
  }
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path')
  return key ? env[key] : undefined
}

async function effectiveSearchPath(
  spawn: SpawnLaunch,
  shell: AgentStartupShell,
  launch: NonNullable<ReturnType<typeof readLaunchPosition>>
): Promise<string> {
  const pathKey = (name: string): boolean =>
    process.platform === 'win32' ? name.toLowerCase() === 'path' : name === 'PATH'
  const scopedPath = [...launch.env].findLast(([name]) => pathKey(name))
  const launchEnvPath = launchPath(spawn.env ?? {})
  const shellOverride =
    process.platform === 'win32'
      ? shell === 'cmd'
        ? null
        : shell === 'posix'
          ? await resolveWindowsGitBashShellPathAsync(spawn.shellOverride ?? 'git-bash')
          : spawn.shellOverride
      : spawn.shellOverride
  const initialEnv =
    launchEnvPath !== undefined || spawn.envToDelete?.some(pathKey)
      ? Object.fromEntries([
          ...Object.entries(process.env).filter(([key]) => !pathKey(key)),
          ...(launchEnvPath === undefined || spawn.envToDelete?.some(pathKey)
            ? []
            : [['PATH', launchEnvPath]])
        ])
      : undefined
  const path = scopedPath
    ? scopedPath[1]
    : launchPath(await resolveLoginShellEnvironment({ shellOverride, env: initialEnv }))
  const nativePath =
    process.platform === 'win32' && shell === 'posix'
      ? msysDrivePathToWindows
      : (value: string) => value
  const cwd = resolve(nativePath(spawn.cwd ?? process.cwd()), nativePath(launch.cwd ?? '.'))
  const directories =
    path !== undefined && (path !== '' || process.platform !== 'win32')
      ? path
          .split(delimiter)
          .map((entry) => resolve(cwd, nativePath(normalizePathEntry(process.platform, entry))))
      : []
  return (
    process.platform === 'win32' && shell === 'cmd' ? [cwd, ...directories] : directories
  ).join(delimiter)
}

export async function alignManagedAgentLaunchAtSpawn(
  spawn: SpawnLaunch,
  shell: AgentStartupShell
): Promise<string | undefined> {
  const command = spawn.launchCommand
  if (!command) {
    return command
  }
  if (isFreshOmpLaunchCommand(command)) {
    return prepareFreshOmpLaunch(command, shell, (inner) =>
      resolveLaunchExecutable(spawn, shell, inner)
    )
  }
  return resolveLaunchExecutable(spawn, shell, command)
}

async function resolveLaunchExecutable(
  spawn: SpawnLaunch,
  shell: AgentStartupShell,
  command: string
): Promise<string> {
  const prefix = command.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS)
  if (!stockPrograms.some((program) => prefix.includes(program))) {
    return command
  }
  const launch = readLaunchPosition(command, shell)
  if (!launch) {
    return command
  }
  const program =
    process.platform === 'win32' && shell === 'posix'
      ? msysDrivePathToWindows(launch.executable)
      : launch.executable
  const managedAgent = managedPathAgent(program)
  const agent = managedAgent ?? stockAgents.get(launch.executable)
  if (!agent) {
    return command
  }
  const settings = spawn.getSettings?.()
  const override = settings?.agentCmdOverrides?.[agent]
  const explicitProgram =
    managedAgent && override ? readLaunchPosition(override, shell)?.executable : undefined
  if (
    explicitProgram &&
    normalizeRuntimePathForComparison(explicitProgram) ===
      normalizeRuntimePathForComparison(launch.executable)
  ) {
    return command
  }
  if (spawn.codexRuntime === 'wsl') {
    return managedAgent
      ? replaceLaunchExecutable(command, shell, launch, stockLaunchProgram(agent, 'linux', true))
      : command
  }
  if (!settings && !managedAgent) {
    return command
  }
  const stock = stockLaunchProgram(agent, process.platform)
  const pathEnv = await effectiveSearchPath(spawn, shell, launch)
  const paths = await readHostManagedAgentCommands(settings ?? {}, [agent], {
    pathEnv,
    shell,
    forDelivery: true
  })
  return replaceLaunchExecutable(command, shell, launch, paths[agent] ?? stock)
}
