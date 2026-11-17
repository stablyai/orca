import { structuredAgentCommandPlan } from '../../../shared/agent-launch/startup/tui-agent-launch-command-override'
import { projectAgentLaunchProfile } from '../../../shared/agent-launch/choices/agent-launch-profile'
import { isTuiAgent } from '../../../shared/agent-launch/catalog/tui-agent-config'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import {
  resolveTuiAgentLaunchArgs,
  type AgentLaunchProfileSettings
} from '../../../shared/agent-launch/choices/tui-agent-launch-defaults'
import { tokenizeStartupCommand } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/shell/launch/windows-terminal-shell'
import { withoutAgentEffortArgs } from '../../../shared/agent-launch/choices/agent-choice-args'

/** Match terminal argument grouping before filtering provider-owned flags. */
export function structuredAgentConfiguredArgs(
  agent: string,
  settings: AgentLaunchProfileSettings & Partial<Pick<GlobalSettings, 'terminalWindowsShell'>>,
  platform: NodeJS.Platform = process.platform,
  omitEffort?: true
): string[] {
  const shell =
    resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote: false,
      terminalWindowsShell: settings.terminalWindowsShell
    }) ?? 'posix'
  const source = isTuiAgent(agent)
    ? projectAgentLaunchProfile(
        agent,
        { ...settings, agentLaunchChoices: undefined },
        { target: 'structured', shell }
      ).args
    : resolveTuiAgentLaunchArgs(agent, settings)
  const cleared = omitEffort && isTuiAgent(agent) ? withoutAgentEffortArgs(agent, source) : source
  if (cleared === null) {
    throw new Error(`${agent} Arguments cannot safely omit effort.`)
  }
  const parsed = tokenizeStartupCommand(cleared, shell)
  if (!parsed.ok) {
    throw new Error(`${agent} Arguments are invalid: ${parsed.error}`)
  }
  return parsed.tokens
}

/** Native argv still uses the common effort-carrier proof before provider conversion. */
export function withoutStructuredAgentEffortArgs(agent: string, args: readonly string[]): string[] {
  if (!isTuiAgent(agent)) {
    throw new Error(`${agent} cannot safely omit effort.`)
  }
  const source = args.map((arg) => JSON.stringify(arg)).join(' ')
  const cleared = withoutAgentEffortArgs(agent, source)
  if (cleared === null) {
    throw new Error(`${agent} Arguments cannot safely omit effort.`)
  }
  if (cleared === source) {
    return [...args]
  }
  const original = tokenizeStartupCommand(source, 'posix')
  if (!original.ok || JSON.stringify(original.tokens) !== JSON.stringify(args)) {
    throw new Error(`${agent} Arguments cannot safely omit effort.`)
  }
  const parsed = tokenizeStartupCommand(cleared, 'posix')
  if (!parsed.ok) {
    throw new Error(`${agent} Arguments cannot safely omit effort.`)
  }
  return parsed.tokens
}

/** A Command override is opaque user code; refuse rather than rewrite its prefix. */
export function assertStructuredAgentEffortPrefix(agent: string, args: readonly string[]): void {
  const cleared = withoutStructuredAgentEffortArgs(agent, args)
  if (JSON.stringify(cleared) !== JSON.stringify(args)) {
    throw new Error(`${agent} Command carries effort and cannot launch with Default effort.`)
  }
}

export function assertStructuredAgentEffortCommand(
  agent: string,
  settings: Partial<Pick<GlobalSettings, 'agentCmdOverrides'>>
): void {
  if (!isTuiAgent(agent)) {
    throw new Error(`${agent} cannot safely omit effort.`)
  }
  const override = settings.agentCmdOverrides?.[agent]
  if (!override?.trim()) {
    return
  }
  const plan = structuredAgentCommandPlan(override, process.platform)
  if (!plan) {
    throw new Error(`${agent} Command cannot safely omit effort.`)
  }
  assertStructuredAgentEffortPrefix(agent, plan.prefixArgs)
}
