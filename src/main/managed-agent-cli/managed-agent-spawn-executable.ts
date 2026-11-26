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
import { nativeWindowsPathToPosixShellPath } from '../../shared/agent-launch/startup/setup-runner-command'
import {
  setupAgentProgramExpression,
  type SetupAgentProgram
} from '../../shared/agent-launch/startup/setup-agent-program'
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
import { managedPathAgent } from './managed-agent-legacy-runtime-path'
import {
  resolveSpawnAgentProgram,
  type PreselectedAgentProgram,
  type SpawnProgramContext
} from './spawn-agent-program-selection'

const stockAgents = Object.keys(TUI_AGENT_CONFIG).filter(isTuiAgent)
const stockPrograms = new Set(
  stockAgents.map((agent) =>
    stockProgramKey(stockLaunchProgram(agent, process.platform), process.platform)
  )
)

export type AgentExecutableLaunch = SpawnProgramContext & {
  launchAgent?: TuiAgent
  sourceShell?: AgentStartupShell
  restoring?: boolean
  setupGate?: boolean
}

export type AlignedLaunch = {
  command: string | undefined
  launchConfig?: SleepingAgentLaunchConfig
  blocked?: 'unknown' | 'unavailable'
  rebuiltHermesQuery?: true
  postSetupProgram?: SetupAgentProgram
}

export async function rewriteLaunchExecutable(
  spawn: AgentExecutableLaunch,
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
  const setupGate = spawn.setupGate && generated && shell !== 'cmd'
  let postSetupProgram: SetupAgentProgram | undefined
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
    const selection = await resolveSpawnAgentProgram(
      modelPin ? { ...spawn, requirePinnedProgram: true } : spawn,
      receivingShell,
      [preferred, ...alternatives],
      cmd?.cwd || launch?.cwd,
      pinned,
      onProgramSelected
    )
    let selected = selection.result
    if (setupGate) {
      if (
        'path' in selected &&
        (guest ? selected.path.startsWith('/') : isAbsolute(selected.path))
      ) {
        selected = { kind: 'full-path', path: selected.path }
      } else {
        postSetupProgram = { name: preferred }
        selected = { kind: 'by-name', path: preferred }
      }
    }
    const program = postSetupProgram?.name ?? selection.program
    if (!('path' in selected)) {
      return { command: undefined, launchConfig: config, blocked: selected.kind }
    }
    const selectedHead = selected.kind === 'full-path' ? selected.path : program
    const launchHead =
      setupGate &&
      selected.kind === 'full-path' &&
      process.platform === 'win32' &&
      shell === 'posix' &&
      !guest
        ? nativeWindowsPathToPosixShellPath(selectedHead)
        : selectedHead
    if (setupGate && selected.kind === 'full-path') {
      postSetupProgram = { name: program, path: launchHead }
    }
    const replaceable =
      executable &&
      (nameFor(agent, executable) || (sourceProgram && isAbsoluteProgram(sourceProgram)))
    if (setupGate && executable && !replaceable) {
      return { command: undefined, launchConfig: config, blocked: 'unknown' }
    }
    if (executable && replaceable) {
      executable =
        selected.kind === 'full-path'
          ? launchHead
          : matchesStockLaunchProgram(executable, program, platform)
            ? executable
            : program
    }
    if (config) {
      const { selectedExecutable: _previous, ...recipe } = config
      const updateRecipe =
        pinned ||
        postSetupProgram ||
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
                    selectedHead,
                    source,
                    recordedCommand.slice(recorded.end)
                  ) + recordedCommand.slice(recorded.end)
                : replaceLaunchExecutable(recordedCommand, source, recorded, selectedHead)
            }
          : {}),
        commandProvenance: 'generated',
        ...(selected.kind === 'full-path' ? { selectedExecutable: selected.path } : {})
      }
    }
    if (hermesArgv) {
      if (
        !postSetupProgram &&
        selected.kind === 'by-name' &&
        hermesArgv[0] === program &&
        source === shell
      ) {
        return { command, launchConfig }
      }
      return {
        command: buildHermesQueryCommand(
          [launchHead, ...hermesArgv.slice(1)],
          shell,
          postSetupProgram && shell !== 'cmd' ? setupAgentProgramExpression(shell) : undefined
        ),
        launchConfig,
        rebuiltHermesQuery: true,
        ...(postSetupProgram ? { postSetupProgram } : {})
      }
    }
  }
  const deferred = postSetupProgram ? { postSetupProgram } : {}
  const cmdLaunch = cmd ? generatedCmdLaunchPosition(cmd, command) : launch
  if (
    convertCmd &&
    executable &&
    cmdLaunch &&
    (cmd ||
      agent ||
      config ||
      stockPrograms.has(stockProgramKey(basename(sourceProgram || executable), process.platform)))
  ) {
    const converted = renderCmdLaunchForPowerShell(command, cmdLaunch, executable)
    if (setupGate && converted === null) {
      return { command: undefined, launchConfig, blocked: 'unknown' }
    }
    return { command: converted ?? command, launchConfig, ...deferred }
  }
  if (cmd && executable) {
    return {
      command: renderGeneratedCmdLaunch(cmd, executable),
      launchConfig,
      ...deferred
    }
  }
  if (!launch || !executable) {
    return { command, launchConfig, ...deferred }
  }
  return {
    command: replaceLaunchExecutable(command, shell, launch, executable),
    launchConfig,
    ...deferred
  }
}
