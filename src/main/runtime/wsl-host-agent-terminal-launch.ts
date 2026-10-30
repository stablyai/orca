import { isWslHostOrcadProcess } from '../ipc/wsl-guest-windows-drive-path'
import { resolveGuestNativeAgentCommand } from '../codex-cli/command'
import {
  isWindowsOnlyAgentCommand,
  windowsOnlyCliMessage
} from '../codex-cli/windows-only-agent-cli'
import type { AgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import {
  getTuiAgentDetectCommands,
  getTuiAgentLaunchCommand,
  TUI_AGENT_CONFIG
} from '../../shared/tui-agent-config'
import { getOrcaCliCommandNameForPlatform } from '../../shared/orca-cli-command-name'
import { hasExplicitTuiLaunchCommand } from '../../shared/tui-agent-launch-command-override'
import {
  quoteStartupArg,
  resolveStartupShell,
  type AgentStartupShell
} from '../../shared/tui-agent-startup-shell'
import type { TuiAgent } from '../../shared/tui-agent'

export type WslHostAgentProbe = {
  isWslHost?: boolean
  mounts?: readonly string[]
  homePath?: string
}

/** Only a Windows copy of a CLI the launch needs exists; callers that degrade (cold restore) catch this. */
export class WslHostWindowsOnlyAgentError extends Error {}

type WslHostAgentCommandArgs = {
  agent: TuiAgent
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  isRemote?: boolean
}

/**
 * On a WSL-host orcad, launch the stock agent by its distro path, or refuse when only a Windows copy
 * exists, as chat does; a bare name would reach the Windows shim through PATH interop. The PTY env is
 * untouched. Unchanged off a WSL host, for remote launches, and under an explicit Command setting.
 */
export function resolveWslHostAgentLaunchInputs(
  inputs: AgentStartupPlanInputs,
  pathEnv?: string,
  probe: WslHostAgentProbe = {}
): AgentStartupPlanInputs {
  const cmdOverrides = resolveWslHostAgentCmdOverrides(inputs, pathEnv, probe)
  return cmdOverrides === inputs.cmdOverrides ? inputs : { ...inputs, cmdOverrides }
}

/** The same rule for builders that take the override map directly (fork); same map when unchanged. */
export function resolveWslHostAgentCmdOverrides(
  args: WslHostAgentCommandArgs,
  pathEnv?: string,
  probe: WslHostAgentProbe = {}
): Partial<Record<TuiAgent, string>> {
  if (!appliesOnWslHost(args, probe)) {
    return args.cmdOverrides
  }
  const { agent, platform } = args
  const [, ...rest] = getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[agent], platform).split(' ')
  const head = resolveWslHostStockProgram(agent, platform, args.shell, pathEnv, probe)
  return head ? { ...args.cmdOverrides, [agent]: [head, ...rest].join(' ') } : args.cmdOverrides
}

/** Resumes also replay the command a launch recorded; a recorded stock name gets the same rule. */
export function resolveWslHostAgentResumeInputs<
  T extends WslHostAgentCommandArgs & { agentCommand?: string | null }
>(args: T, pathEnv?: string, probe: WslHostAgentProbe = {}): T {
  const recorded = args.agentCommand?.trim()
  if (!recorded) {
    const cmdOverrides = resolveWslHostAgentCmdOverrides(args, pathEnv, probe)
    return cmdOverrides === args.cmdOverrides ? args : { ...args, cmdOverrides }
  }
  const [program, ...rest] = recorded.split(' ')
  // Absolute or custom recorded commands are the user's (or already pinned); leave them.
  if (
    !appliesOnWslHost(args, probe) ||
    !getTuiAgentDetectCommands(TUI_AGENT_CONFIG[args.agent]).includes(program)
  ) {
    return args
  }
  const head = resolveWslHostStockProgram(args.agent, args.platform, args.shell, pathEnv, probe)
  return head ? { ...args, agentCommand: [head, ...rest].join(' ') } : args
}

function appliesOnWslHost(args: WslHostAgentCommandArgs, probe: WslHostAgentProbe): boolean {
  return (
    (probe.isWslHost ?? isWslHostOrcadProcess()) &&
    !args.isRemote &&
    !hasExplicitTuiLaunchCommand({ agentCmdOverrides: args.cmdOverrides }, args.agent)
  )
}

/** The shell-quoted distro path of the agent's stock program; null to leave the launch as is. */
function resolveWslHostStockProgram(
  agent: TuiAgent,
  platform: NodeJS.Platform,
  shell: AgentStartupShell | undefined,
  pathEnv: string | undefined,
  probe: WslHostAgentProbe
): string | null {
  const config = TUI_AGENT_CONFIG[agent]
  const [program] = getTuiAgentLaunchCommand(config, platform).split(' ')
  const options = { pathEnv, platform, ...(probe.homePath ? { homePath: probe.homePath } : {}) }
  // A CLI the agent runs under its own command (Agent Teams' claude, dsh's dsh) can't be Windows-only either.
  for (const name of config.detectRequiredCommands ?? []) {
    const required = resolveGuestNativeAgentCommand(name, options, probe.mounts)
    if (isWindowsOnlyAgentCommand(required)) {
      throw windowsOnlyRefusal(required, name, agent)
    }
  }
  // Wrapper launches (Agent Teams runs Orca's CLI as `orca` or `orca-ide`) keep their command.
  if (
    program !== config.detectCmd ||
    getTuiAgentDetectCommands(config).includes(getOrcaCliCommandNameForPlatform(platform))
  ) {
    return null
  }
  let windowsOnly: string | null = null
  // A native alias (qoder for qodercli) beats a Windows-only primary name.
  for (const name of getTuiAgentDetectCommands(config)) {
    const candidate = resolveGuestNativeAgentCommand(name, options, probe.mounts)
    if (isWindowsOnlyAgentCommand(candidate)) {
      windowsOnly ??= candidate
    } else if (candidate !== name) {
      return quoteStartupArg(candidate, resolveStartupShell(platform, shell))
    }
  }
  if (windowsOnly) {
    throw windowsOnlyRefusal(windowsOnly, agent, agent)
  }
  return null
}

function windowsOnlyRefusal(
  command: string,
  cli: string,
  agent: TuiAgent
): WslHostWindowsOnlyAgentError {
  return new WslHostWindowsOnlyAgentError(
    `${windowsOnlyCliMessage(command, cli)} Or set the ${agent} Command setting to a program inside the distro.`
  )
}
