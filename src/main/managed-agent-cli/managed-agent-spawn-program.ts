import { basename, isAbsolute, join, resolve } from 'node:path'
import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../shared/concurrency/abort-signal-reason'
import {
  matchesStockLaunchProgram,
  renderCmdLaunchForPowerShell,
  replaceLaunchExecutable,
  stockLaunchProgram,
  stockProgramKey
} from '../../shared/agent-launch/startup/managed-agent-launch-program'
import {
  isFreshOmpLaunchCommand,
  prepareFreshOmpLaunch
} from '../../shared/agent-launch/startup/omp-fresh-launch'
import {
  readLaunchPosition,
  type LaunchPosition
} from '../../shared/agent-launch/startup/launch-position'
import type { AgentStartupShell } from '../../shared/agent-launch/startup/tui-agent-startup-shell'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../shared/agent-launch/catalog/tui-agent-config'
import {
  msysDrivePathToWindows,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../shared/file-access/cross-platform-path'
import { toWindowsWslDrivePath } from '../../shared/file-access/wsl-paths'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session/lifecycle/agent-session-resume'
import type { NativeChatSignInRequest } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { MANAGED_AGENT_CLI_IDS, managedAgentCli } from './managed-agent-cli-registry'
import { isOrcaAgentRuntimePath } from './managed-agent-cli-path'
import { resolveCmdLaunchFolderProgram } from '../ipc/command-path/cmd-launch-folder-program'
import { checkExecutableFile } from '../ipc/command-path/command-path-directory'
import {
  selectTerminalAgentProgram,
  withAgentInventoryDeadline,
  type TerminalAgentProgramSelection
} from '../preflight/agent-command-detection'
import { prepareNativeChatSignIn } from './prepare-native-chat-sign-in'

type SpawnSettings = Parameters<typeof prepareNativeChatSignIn>[1]
const stockAgents = Object.keys(TUI_AGENT_CONFIG).filter(isTuiAgent)
const stockPrograms = new Set(
  stockAgents.map((agent) =>
    stockProgramKey(stockLaunchProgram(agent, process.platform), process.platform)
  )
)

type SpawnLaunch = {
  launchCommand: string | undefined
  launchConfig?: SleepingAgentLaunchConfig
  launchAgent?: TuiAgent
  nativeChatSignIn?: NativeChatSignInRequest
  codexRuntime?: 'host' | 'wsl'
  expectedWslDistro?: string | null
  sshTarget?: boolean
  getSettings?: () => SpawnSettings | undefined
  cwd?: string
  readCwd?: () => Promise<string | undefined>
  sourceShell?: AgentStartupShell
  restoring?: boolean
  env?: Record<string, string | undefined>
}

type AlignedLaunch = {
  command: string | undefined
  launchConfig?: SleepingAgentLaunchConfig
  blocked?: 'unknown' | 'unavailable'
}

function managedPathAgent(program: string): TuiAgent | undefined {
  if (!isAbsolute(program) || !/[\\/]agent-runtimes[\\/]/i.test(program)) {
    return undefined
  }
  const dataDirectory = getProfileUserDataPath()
  return MANAGED_AGENT_CLI_IDS.find((agent) => {
    const cli = managedAgentCli(agent)
    const root = cli.runtime.root(dataDirectory)
    const release = relativePathInsideRoot(root, program)?.split('/')[0]
    if (!release || release === '.' || release === '..') {
      return false
    }
    const folder = join(root, release)
    const actual = normalizeRuntimePathForComparison(program)
    return (
      actual === normalizeRuntimePathForComparison(cli.executable(folder)) ||
      (cli.launcher !== undefined &&
        actual === normalizeRuntimePathForComparison(cli.launcher(folder)))
    )
  })
}

async function selectProgram(
  spawn: SpawnLaunch,
  shell: AgentStartupShell,
  programs: readonly [string, ...string[]],
  launch: LaunchPosition,
  pinned: string | undefined,
  signal: AbortSignal
): Promise<TerminalAgentProgramSelection> {
  const preferred = programs[0]
  if (spawn.codexRuntime === 'wsl') {
    return selectTerminalAgentProgram(programs, shell, {
      wsl: { distro: spawn.expectedWslDistro ?? undefined },
      signal
    })
  }
  if (spawn.sshTarget) {
    // SSH panes execute the name in the guest shell, with no desktop runtime paths.
    return { program: preferred, result: { kind: 'by-name', path: preferred } }
  }
  if (pinned && isAbsolute(pinned) && !isOrcaAgentRuntimePath(pinned)) {
    const checked = await waitForPromiseWithSignal(
      checkExecutableFile(pinned, process.platform === 'win32'),
      signal
    )
    if (checked === 'executable') {
      return { program: preferred, result: { kind: 'full-path', path: pinned } }
    }
    if (checked === 'unknown') {
      return { program: preferred, result: { kind: 'unknown' } }
    }
  }
  const selection = await selectTerminalAgentProgram(programs, shell, {
    refresh: Boolean(pinned),
    signal
  })
  const { program, result: selected } = selection
  throwIfSignalAborted(signal)
  if (
    selected.kind === 'by-name' &&
    Object.keys(spawn.launchConfig?.agentEnv ?? {}).some((key) =>
      process.platform === 'win32' ? /^(path|pathext)$/i.test(key) : key === 'PATH'
    )
  ) {
    return { program, result: { kind: 'full-path', path: selected.path } }
  }
  if (process.platform !== 'win32' || shell !== 'cmd' || selected.kind !== 'by-name') {
    return selection
  }
  const launchCwd = launch.cwd ?? '.'
  const cwd = isAbsolute(launchCwd)
    ? launchCwd
    : resolve(
        (spawn.readCwd && (await waitForPromiseWithSignal(spawn.readCwd(), signal))) ||
          spawn.cwd ||
          process.cwd(),
        launchCwd
      )
  throwIfSignalAborted(signal)
  const pathExt =
    Object.entries(spawn.env ?? {}).find(([key]) => key.toLowerCase() === 'pathext')?.[1] ??
    process.env.PATHEXT
  const first = await resolveCmdLaunchFolderProgram(program, cwd, pathExt, signal)
  return first &&
    normalizeRuntimePathForComparison(first) !== normalizeRuntimePathForComparison(selected.path)
    ? { program, result: { kind: 'full-path', path: selected.path } }
    : selection
}

export async function alignManagedAgentLaunchAtSpawn(
  spawn: SpawnLaunch,
  shell: AgentStartupShell
): Promise<AlignedLaunch> {
  const command = spawn.launchCommand
  const config = spawn.launchConfig
  if (!command) {
    return { command, launchConfig: config }
  }
  if (spawn.nativeChatSignIn) {
    const prepared = await prepareNativeChatSignIn(
      spawn.sshTarget
        ? { kind: 'ssh', connectionId: '' }
        : {
            kind: 'local',
            context: spawn.codexRuntime === 'wsl' ? { wslDefault: true } : undefined
          },
      spawn.getSettings?.() ?? {},
      spawn.nativeChatSignIn,
      shell
    )
    return { command: prepared ?? command, launchConfig: config }
  }
  if (isFreshOmpLaunchCommand(command)) {
    let aligned: AlignedLaunch | undefined
    const guarded = await prepareFreshOmpLaunch(command, shell, async (inner) => {
      aligned = await rewriteLaunchExecutable(spawn, shell, inner)
      return aligned.command ?? inner
    })
    return aligned
      ? { ...aligned, command: aligned.blocked ? undefined : guarded }
      : { command, launchConfig: config }
  }
  return rewriteLaunchExecutable(spawn, shell, command)
}

async function rewriteLaunchExecutable(
  spawn: SpawnLaunch,
  shell: AgentStartupShell,
  command: string
): Promise<AlignedLaunch> {
  const config = spawn.launchConfig
  const source = spawn.sourceShell ?? shell
  const convertCmd = source === 'cmd' && shell === 'powershell'
  const generated = config?.commandProvenance === 'generated'
  const legacy = !config?.commandProvenance && spawn.restoring

  if (!convertCmd && !generated && !legacy) {
    return { command, launchConfig: config }
  }
  const launch = readLaunchPosition(command, source)
  if (!launch) {
    return {
      command: generated ? undefined : command,
      launchConfig: config,
      ...(generated ? { blocked: 'unknown' as const } : {})
    }
  }
  const guest = spawn.sshTarget || spawn.codexRuntime === 'wsl'
  const platform = guest ? 'linux' : process.platform
  const stock = (agent: TuiAgent) => stockLaunchProgram(agent, platform, guest)
  const namesFor = (agent: TuiAgent) => [
    stock(agent),
    ...(TUI_AGENT_CONFIG[agent].detectCmdAliases ?? [])
  ]
  const nameFor = (agent: TuiAgent, program: string | undefined) =>
    namesFor(agent).find((name) => matchesStockLaunchProgram(program, name, platform))
  const sourceProgram =
    spawn.codexRuntime === 'wsl'
      ? (toWindowsWslDrivePath(launch.executable) ?? launch.executable)
      : process.platform === 'win32' && source === 'posix'
        ? msysDrivePathToWindows(launch.executable)
        : launch.executable
  const recorded = config?.agentCommand ? readLaunchPosition(config.agentCommand, source) : launch
  const bare =
    recorded &&
    !recorded.env.size &&
    !recorded.bypassesShellFunction &&
    !recorded.hasCallOperator &&
    (!recorded.cwd || !config?.agentCommand)
  const oldAgent = legacy
    ? (managedPathAgent(sourceProgram) ??
      (bare
        ? [spawn.launchAgent, ...stockAgents].find(
            (agent) => agent && nameFor(agent, recorded.executable)
          )
        : undefined))
    : undefined
  const agent = generated
    ? (spawn.launchAgent ?? stockAgents.find((candidate) => nameFor(candidate, launch.executable)))
    : oldAgent
  if (generated && !agent) {
    return { command: undefined, launchConfig: config, blocked: 'unknown' }
  }
  let executable = launch.executable
  let launchConfig = config
  if (agent) {
    const primary = stock(agent)
    const recordedName = nameFor(agent, recorded?.executable)
    const preferred = nameFor(agent, launch.executable) ?? recordedName ?? primary
    const alternatives =
      agent === 'qoder' ? namesFor(agent).filter((name) => name !== preferred) : []
    const pinned = spawn.restoring ? config?.selectedExecutable : undefined
    const { program, result: selected } = await withAgentInventoryDeadline((signal) =>
      selectProgram(spawn, shell, [preferred, ...alternatives], launch, pinned, signal)
    ).catch(() => ({ program: preferred, result: { kind: 'unknown' as const } }))
    if (!('path' in selected)) {
      return { command: undefined, launchConfig: config, blocked: selected.kind }
    }
    executable =
      selected.kind === 'full-path'
        ? selected.path
        : matchesStockLaunchProgram(launch.executable, program, platform)
          ? launch.executable
          : program
    if (config) {
      const { selectedExecutable: _previous, ...recipe } = config
      const updateRecipe =
        oldAgent ||
        program !== primary ||
        program !== preferred ||
        (recordedName && recordedName !== program)
      launchConfig = {
        ...recipe,
        ...(updateRecipe && recorded && config.agentCommand
          ? {
              agentCommand: replaceLaunchExecutable(config.agentCommand, source, recorded, program)
            }
          : {}),
        commandProvenance: 'generated',
        ...(selected.kind === 'full-path' ? { selectedExecutable: selected.path } : {})
      }
    }
  }
  return {
    command:
      convertCmd &&
      (agent ||
        config ||
        stockPrograms.has(stockProgramKey(basename(sourceProgram), process.platform)))
        ? (renderCmdLaunchForPowerShell(command, launch, executable) ?? command)
        : replaceLaunchExecutable(command, shell, launch, executable),
    launchConfig
  }
}
