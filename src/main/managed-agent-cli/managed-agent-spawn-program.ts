import { basename, isAbsolute, join, win32 } from 'node:path'
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
import { readLaunchPosition } from '../../shared/agent-launch/startup/launch-position'
import {
  buildHermesQueryCommand,
  matchesGeneratedHermesQuery,
  ORCA_HERMES_STARTUP_QUERY_ARGV_ENV,
  readGeneratedHermesQueryArgv
} from '../../shared/agent-launch/startup/hermes-startup-query'
import {
  GENERATED_AGENT_LAUNCH_ENV,
  readGeneratedAgentLaunchInputs
} from '../../shared/agent-launch/startup/generated-agent-launch-inputs'
import {
  generatedCmdLaunchPosition,
  renderGeneratedCmdLaunch
} from '../../shared/agent-launch/startup/generated-cmd-launch'
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
import { withAgentInventoryDeadline } from '../preflight/agent-command-detection'
import { prepareNativeChatSignIn } from './prepare-native-chat-sign-in'
import { selectSpawnAgentProgram, type SpawnProgramContext } from './spawn-agent-program-selection'

type SpawnSettings = Parameters<typeof prepareNativeChatSignIn>[1]
const stockAgents = Object.keys(TUI_AGENT_CONFIG).filter(isTuiAgent)
const stockPrograms = new Set(
  stockAgents.map((agent) =>
    stockProgramKey(stockLaunchProgram(agent, process.platform), process.platform)
  )
)

type SpawnLaunch = SpawnProgramContext & {
  launchCommand: string | undefined
  launchAgent?: TuiAgent
  nativeChatSignIn?: NativeChatSignInRequest
  getSettings?: () => SpawnSettings | undefined
  sourceShell?: AgentStartupShell
  restoring?: boolean
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
  if (spawn.sshTarget && !(spawn.sourceShell === 'cmd' && shell === 'powershell')) {
    return { command, launchConfig: config }
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
  const inputs = generated
    ? readGeneratedAgentLaunchInputs(spawn.env?.[GENERATED_AGENT_LAUNCH_ENV])
    : undefined
  const cmd =
    source === 'cmd' && inputs?.kind === 'cmd' && renderGeneratedCmdLaunch(inputs) === command
      ? inputs
      : undefined
  const hermesArgv =
    generated && (!spawn.launchAgent || spawn.launchAgent === 'hermes')
      ? inputs?.kind === 'hermes-query' && matchesGeneratedHermesQuery(inputs.argv, command, source)
        ? inputs.argv
        : readGeneratedHermesQueryArgv(
            spawn.env?.[ORCA_HERMES_STARTUP_QUERY_ARGV_ENV],
            command,
            source
          )
      : undefined
  const launch = cmd || hermesArgv ? null : readLaunchPosition(command, source)
  const originalExecutable = cmd?.executable ?? launch?.executable
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
    originalExecutable &&
    (spawn.codexRuntime === 'wsl'
      ? (toWindowsWslDrivePath(originalExecutable) ?? originalExecutable)
      : process.platform === 'win32' && source === 'posix'
        ? msysDrivePathToWindows(originalExecutable)
        : originalExecutable)
  const isAbsoluteProgram = cmd ? win32.isAbsolute : isAbsolute
  const recorded = config?.agentCommand ? readLaunchPosition(config.agentCommand, source) : launch
  const bare =
    recorded &&
    !recorded.env.size &&
    !recorded.bypassesShellFunction &&
    !recorded.hasCallOperator &&
    (!recorded.cwd || !config?.agentCommand)
  const oldAgent = legacy
    ? ((sourceProgram ? managedPathAgent(sourceProgram) : undefined) ??
      (bare
        ? [spawn.launchAgent, ...stockAgents].find(
            (agent) => agent && nameFor(agent, recorded.executable)
          )
        : undefined))
    : undefined
  const agent = generated
    ? (spawn.launchAgent ??
      (hermesArgv
        ? 'hermes'
        : stockAgents.find(
            (candidate) =>
              nameFor(candidate, originalExecutable) || nameFor(candidate, recorded?.executable)
          )))
    : oldAgent
  if (generated && (!agent || (!originalExecutable && !hermesArgv))) {
    return { command: undefined, launchConfig: config, blocked: 'unknown' }
  }
  let executable = originalExecutable
  let launchConfig = config
  if (agent) {
    const primary = stock(agent)
    const recordedName = nameFor(agent, recorded?.executable)
    const preferred = nameFor(agent, executable) ?? recordedName ?? primary
    const alternatives =
      agent === 'qoder' ? namesFor(agent).filter((name) => name !== preferred) : []
    const pinned = spawn.restoring ? config?.selectedExecutable : undefined
    const receivingShell = hermesArgv && shell === 'cmd' ? 'powershell' : shell
    const { program, result: selected } = await withAgentInventoryDeadline((signal) =>
      selectSpawnAgentProgram(
        spawn,
        receivingShell,
        [preferred, ...alternatives],
        cmd?.cwd || launch?.cwd,
        pinned,
        signal
      )
    ).catch(() => ({ program: preferred, result: { kind: 'unknown' as const } }))
    if (!('path' in selected)) {
      return { command: undefined, launchConfig: config, blocked: selected.kind }
    }
    if (
      executable &&
      (nameFor(agent, executable) || (sourceProgram && isAbsoluteProgram(sourceProgram)))
    ) {
      executable =
        selected.kind === 'full-path'
          ? selected.path
          : matchesStockLaunchProgram(executable, program, platform)
            ? executable
            : program
    }
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
    if (hermesArgv) {
      return {
        command: buildHermesQueryCommand(
          [selected.kind === 'full-path' ? selected.path : program, ...hermesArgv.slice(1)],
          shell
        ),
        launchConfig
      }
    }
  }
  if (cmd && executable) {
    return {
      command: convertCmd
        ? (renderCmdLaunchForPowerShell(
            command,
            generatedCmdLaunchPosition(cmd, command),
            executable
          ) ?? command)
        : renderGeneratedCmdLaunch(cmd, executable),
      launchConfig
    }
  }
  if (!launch || !executable) {
    return { command, launchConfig }
  }
  return {
    command:
      convertCmd &&
      (agent ||
        config ||
        stockPrograms.has(stockProgramKey(basename(sourceProgram || executable), process.platform)))
        ? (renderCmdLaunchForPowerShell(command, launch, executable) ?? command)
        : replaceLaunchExecutable(command, shell, launch, executable),
    launchConfig
  }
}
