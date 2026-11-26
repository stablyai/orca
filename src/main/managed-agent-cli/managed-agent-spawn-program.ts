import { basename, isAbsolute, win32 } from 'node:path'
import {
  matchesStockLaunchProgram,
  renderCmdLaunchForPowerShell,
  renderPinnedLaunchHead,
  replaceLaunchExecutable,
  savedLaunchProgramHead,
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
import { msysDrivePathToWindows } from '../../shared/file-access/cross-platform-path'
import { toWindowsWslDrivePath } from '../../shared/file-access/wsl-paths'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session/lifecycle/agent-session-resume'
import type { NativeChatSignInRequest } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { managedPathAgent } from './managed-agent-legacy-runtime-path'
import { prepareNativeChatSignIn } from './prepare-native-chat-sign-in'
import {
  resolveSpawnAgentProgram,
  type PreselectedAgentProgram,
  type SpawnProgramContext
} from './spawn-agent-program-selection'

export type { PreselectedAgentProgram } from './spawn-agent-program-selection'

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
  rebuiltHermesQuery?: true
}

export async function alignManagedAgentLaunchAtSpawn(
  spawn: SpawnLaunch,
  shell: AgentStartupShell,
  onProgramSelected?: (program: PreselectedAgentProgram) => void
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
      aligned = await rewriteLaunchExecutable(spawn, shell, inner, onProgramSelected)
      return aligned.command ?? inner
    })
    return aligned
      ? { ...aligned, command: aligned.blocked ? undefined : guarded }
      : { command, launchConfig: config }
  }
  return rewriteLaunchExecutable(spawn, shell, command, onProgramSelected)
}

async function rewriteLaunchExecutable(
  spawn: SpawnLaunch,
  shell: AgentStartupShell,
  command: string,
  onProgramSelected?: (program: PreselectedAgentProgram) => void
): Promise<AlignedLaunch> {
  const config = spawn.launchConfig
  const source = spawn.sourceShell ?? shell
  const convertCmd = source === 'cmd' && shell === 'powershell'
  const generated = config?.commandProvenance === 'generated'
  const pin = config?.selectedExecutable
  const legacy = !config?.commandProvenance && spawn.restoring

  if (!convertCmd && !generated && !legacy) {
    return { command, launchConfig: config }
  }
  if (generated && pin && spawn.restoring) {
    command = renderPinnedLaunchHead(command, pin, source)
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
  const recordedCommand =
    generated && pin && config.agentCommand
      ? renderPinnedLaunchHead(config.agentCommand, pin, source)
      : config?.agentCommand
  const recorded = recordedCommand ? readLaunchPosition(recordedCommand, source) : launch
  const bare =
    recorded &&
    !recorded.env.size &&
    !recorded.bypassesShellFunction &&
    !recorded.hasCallOperator &&
    (!recorded.cwd || !config?.agentCommand)
  const pinName = pin ? basename(pin) : undefined
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
              nameFor(candidate, originalExecutable) ||
              nameFor(candidate, recorded?.executable) ||
              nameFor(candidate, pinName)
          )))
    : oldAgent
  if (generated && (!agent || (!originalExecutable && !hermesArgv))) {
    return { command: undefined, launchConfig: config, blocked: 'unknown' }
  }
  let executable = originalExecutable
  let launchConfig = config
  if (agent) {
    const primary = stock(agent)
    const recordedName = nameFor(agent, recorded?.executable) ?? nameFor(agent, pinName)
    const preferred = nameFor(agent, executable) ?? recordedName ?? primary
    const alternatives =
      agent === 'qoder' ? namesFor(agent).filter((name) => name !== preferred) : []
    const modelPin =
      !spawn.restoring && agent === 'opencode' && pin !== undefined && pin === recorded?.executable
    const pinned = spawn.restoring || modelPin ? pin : undefined
    const receivingShell = hermesArgv && shell === 'cmd' ? 'powershell' : shell
    const { program, result: selected } = await resolveSpawnAgentProgram(
      modelPin ? { ...spawn, requirePinnedProgram: true } : spawn,
      receivingShell,
      [preferred, ...alternatives],
      cmd?.cwd || launch?.cwd,
      pinned,
      onProgramSelected
    )
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
        pinned ||
        selected.kind === 'full-path' ||
        oldAgent ||
        program !== primary ||
        program !== preferred ||
        (recordedName && recordedName !== program)
      launchConfig = {
        ...recipe,
        ...(updateRecipe && recorded && recordedCommand
          ? {
              agentCommand: /^[ \t]*(?:&[ \t]+)?$/.test(recordedCommand.slice(0, recorded.start))
                ? savedLaunchProgramHead(
                    selected.kind === 'full-path' ? selected.path : program,
                    source,
                    recordedCommand.slice(recorded.end)
                  ) + recordedCommand.slice(recorded.end)
                : replaceLaunchExecutable(
                    recordedCommand,
                    source,
                    recorded,
                    selected.kind === 'full-path' ? selected.path : program
                  )
            }
          : {}),
        commandProvenance: 'generated',
        ...(selected.kind === 'full-path' ? { selectedExecutable: selected.path } : {})
      }
    }
    if (hermesArgv) {
      if (selected.kind === 'by-name' && hermesArgv[0] === program && source === shell) {
        return { command, launchConfig }
      }
      return {
        command: buildHermesQueryCommand(
          [selected.kind === 'full-path' ? selected.path : program, ...hermesArgv.slice(1)],
          shell
        ),
        launchConfig,
        rebuiltHermesQuery: true
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
