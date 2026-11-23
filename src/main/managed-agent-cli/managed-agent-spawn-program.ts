import { delimiter, isAbsolute, resolve } from 'node:path'
import {
  renderCmdLaunchForPowerShell,
  replaceLaunchExecutable,
  stockLaunchProgram
} from '../../shared/agent-launch/startup/managed-agent-launch-program'
import {
  isFreshOmpLaunchCommand,
  prepareFreshOmpLaunch
} from '../../shared/agent-launch/startup/omp-fresh-launch'
import { agentSessionSignInCommand } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
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
import { toWindowsWslDrivePath } from '../../shared/file-access/wsl-paths'
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
  sshTarget?: boolean
  getSettings?: () => SpawnSettings | undefined
  cwd?: string
  readCwd?: () => Promise<string | undefined>
  env?: Record<string, string | undefined>
  envToDelete?: readonly string[]
  /** A queued launch has already seeded the PTY; never pass request values into a profile subprocess. */
  queuedPath?: string | null
  shellOverride?: string
  sourceShell?: AgentStartupShell
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
  const profileShell = spawn.sourceShell ?? shell
  const shellOverride =
    !scopedPath && spawn.queuedPath === undefined && process.platform === 'win32'
      ? profileShell === 'cmd'
        ? null
        : profileShell === 'posix'
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
    : spawn.queuedPath !== undefined
      ? (spawn.queuedPath ?? undefined)
      : launchPath(await resolveLoginShellEnvironment({ shellOverride, env: initialEnv }))
  const nativePath =
    process.platform === 'win32' && shell === 'posix'
      ? msysDrivePathToWindows
      : (value: string) => value
  // Profile capture and a PTY's env seed use native delimiters; Bash's inline PATH uses colons.
  const pathDelimiter =
    process.platform === 'win32' && shell === 'posix' && scopedPath ? ':' : delimiter
  const directories =
    path !== undefined && (path !== '' || process.platform !== 'win32')
      ? path
          .split(pathDelimiter)
          .map((entry) => nativePath(normalizePathEntry(process.platform, entry)))
      : []
  const searchesCwd = process.platform === 'win32' && shell === 'cmd'
  if (!searchesCwd && directories.every(isAbsolute)) {
    return directories.join(delimiter)
  }
  const launchCwd = nativePath(launch.cwd ?? '.')
  const cwd = isAbsolute(launchCwd)
    ? launchCwd
    : resolve(nativePath((await spawn.readCwd?.()) || spawn.cwd || process.cwd()), launchCwd)
  const absoluteDirectories = directories.map((entry) => resolve(cwd, entry))
  return (searchesCwd ? [cwd, ...absoluteDirectories] : absoluteDirectories).join(delimiter)
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
  // The system sign-in deliberately bypasses Claude's shell function after restoring its config.
  if (
    command.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS).includes('ORCA_CLAUDE_INJECTED_CONFIG_DIR') &&
    command === agentSessionSignInCommand('claude', { account: 'system', remote: false, shell })
  ) {
    const invocation = await resolveLaunchExecutable(spawn, shell, 'claude')
    const program = readLaunchPosition(invocation, shell)?.executable
    return program && program !== 'claude'
      ? (agentSessionSignInCommand('claude', {
          account: 'system',
          remote: false,
          shell,
          managedCommand: program
        }) ?? command)
      : command
  }
  return resolveLaunchExecutable(spawn, shell, command)
}

async function resolveLaunchExecutable(
  spawn: SpawnLaunch,
  shell: AgentStartupShell,
  command: string
): Promise<string> {
  const prefix = command.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS)
  if (
    !stockPrograms.some((program) => prefix.includes(program)) &&
    !/[\\/]agent-runtimes[\\/]/i.test(prefix)
  ) {
    return command
  }
  const sourceShell = spawn.sourceShell ?? shell
  const launch = readLaunchPosition(command, sourceShell)
  if (!launch) {
    return command
  }
  const program =
    process.platform === 'win32' && sourceShell === 'posix'
      ? ((spawn.codexRuntime === 'wsl' ? toWindowsWslDrivePath(launch.executable) : null) ??
        msysDrivePathToWindows(launch.executable))
      : launch.executable
  const managedAgent = managedPathAgent(program)
  const agent = managedAgent ?? stockAgents.get(launch.executable)
  if (!agent) {
    return command
  }
  const settings = spawn.getSettings?.()
  const override = settings?.agentCmdOverrides?.[agent]
  const explicitProgram =
    managedAgent && override ? readLaunchPosition(override, sourceShell)?.executable : undefined
  const render = (executable: string): string =>
    sourceShell === 'cmd' && shell === 'powershell'
      ? (renderCmdLaunchForPowerShell(command, launch, executable) ?? command)
      : replaceLaunchExecutable(command, shell, launch, executable)
  if (
    explicitProgram &&
    normalizeRuntimePathForComparison(explicitProgram) ===
      normalizeRuntimePathForComparison(launch.executable)
  ) {
    return render(launch.executable)
  }
  if (spawn.sshTarget || spawn.codexRuntime === 'wsl') {
    return managedAgent ? render(stockLaunchProgram(agent, 'linux', true)) : command
  }
  if (!settings && !managedAgent) {
    return render(launch.executable)
  }
  const stock = stockLaunchProgram(agent, process.platform)
  const pathEnv = await effectiveSearchPath(spawn, shell, launch)
  const paths = await readHostManagedAgentCommands(settings ?? {}, [agent], {
    pathEnv,
    shell,
    forDelivery: true
  })
  return render(paths[agent] ?? stock)
}
