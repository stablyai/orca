import { projectAgentLaunchProfile } from '../../shared/agent-launch/choices/agent-launch-profile'
import { isTuiAgent } from '../../shared/agent-launch/catalog/tui-agent-config'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  resolveTuiAgentLaunchArgs,
  type AgentLaunchProfileSettings
} from '../../shared/agent-launch/choices/tui-agent-launch-defaults'
import {
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../shared/agent-launch/startup/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'

type ArgumentShellSettings = Partial<Pick<GlobalSettings, 'terminalWindowsShell'>>

function argumentShell(
  settings: ArgumentShellSettings,
  platform: NodeJS.Platform
): AgentStartupShell {
  return (
    resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote: false,
      terminalWindowsShell: settings.terminalWindowsShell
    }) ?? 'posix'
  )
}

function tokenizeAgentArgs(agent: string, args: string, shell: AgentStartupShell): string[] {
  const parsed = tokenizeStartupCommand(args, shell)
  if (!parsed.ok) {
    throw new Error(`${agent} Arguments are invalid: ${parsed.error}`)
  }
  return parsed.tokens
}

/** Split a terminal's recorded arguments the way this host's agent terminals do. */
export function structuredAgentArgTokens(
  agent: string,
  args: string,
  settings: ArgumentShellSettings,
  platform: NodeJS.Platform = process.platform
): string[] {
  return tokenizeAgentArgs(agent, args, argumentShell(settings, platform))
}

/** Match terminal argument grouping before filtering provider-owned flags. */
export function structuredAgentConfiguredArgs(
  agent: string,
  settings: AgentLaunchProfileSettings & ArgumentShellSettings,
  platform: NodeJS.Platform = process.platform
): string[] {
  const shell = argumentShell(settings, platform)
  return tokenizeAgentArgs(
    agent,
    isTuiAgent(agent)
      ? projectAgentLaunchProfile(
          agent,
          { ...settings, agentLaunchChoices: undefined },
          { target: 'structured', shell }
        ).args
      : resolveTuiAgentLaunchArgs(agent, settings),
    shell
  )
}
