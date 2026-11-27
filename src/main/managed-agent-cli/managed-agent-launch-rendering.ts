import { basename } from 'node:path'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import {
  renderCmdLaunchForPowerShell,
  replaceLaunchExecutable,
  stockLaunchProgram,
  stockProgramKey
} from '../../shared/agent-launch/startup/managed-agent-launch-program'
import {
  generatedCmdLaunchPosition,
  renderGeneratedCmdLaunch
} from '../../shared/agent-launch/startup/generated-cmd-launch'
import type { GeneratedCmdLaunchInputs } from '../../shared/agent-launch/startup/generated-agent-launch-inputs'
import type { LaunchPosition } from '../../shared/agent-launch/startup/launch-position'
import type { AgentStartupShell } from '../../shared/agent-launch/startup/tui-agent-startup-shell'

export const stockAgents = Object.keys(TUI_AGENT_CONFIG).filter(isTuiAgent)
const stockPrograms = new Set(
  stockAgents.map((agent) =>
    stockProgramKey(stockLaunchProgram(agent, process.platform), process.platform)
  )
)

export function renderManagedAgentLaunchCommand(args: {
  command: string
  shell: AgentStartupShell
  launch: LaunchPosition | null
  executable: string | undefined
  sourceProgram: string | undefined
  cmd: GeneratedCmdLaunchInputs | undefined
  convertCmd: boolean
  agent: TuiAgent | undefined
  hasRecipe: boolean
}): string | null {
  const { command, executable, launch, cmd } = args
  if (!executable) {
    return command
  }
  const cmdLaunch = cmd ? generatedCmdLaunchPosition(cmd, command) : launch
  if (
    args.convertCmd &&
    cmdLaunch &&
    (cmd ||
      args.agent ||
      args.hasRecipe ||
      stockPrograms.has(
        stockProgramKey(basename(args.sourceProgram || executable), process.platform)
      ))
  ) {
    return renderCmdLaunchForPowerShell(command, cmdLaunch, executable)
  }
  if (cmd) {
    return renderGeneratedCmdLaunch(cmd, executable)
  }
  return launch ? replaceLaunchExecutable(command, args.shell, launch, executable) : command
}
