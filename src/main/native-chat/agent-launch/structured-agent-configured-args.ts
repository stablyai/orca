import { projectAgentLaunchProfile } from '../../../shared/agent-launch/choices/agent-launch-profile'
import { isTuiAgent } from '../../../shared/agent-launch/catalog/tui-agent-config'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  resolveTuiAgentLaunchArgs,
  type AgentLaunchProfileSettings
} from '../../../shared/agent-launch/choices/tui-agent-launch-defaults'
import { tokenizeStartupCommand } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'

/** Match terminal argument grouping before filtering provider-owned flags. */
export function structuredAgentConfiguredArgs(
  agent: string,
  settings: AgentLaunchProfileSettings & Partial<Pick<GlobalSettings, 'terminalWindowsShell'>>,
  platform: NodeJS.Platform = process.platform
): string[] {
  const shell =
    resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote: false,
      terminalWindowsShell: settings.terminalWindowsShell
    }) ?? 'posix'
  const parsed = tokenizeStartupCommand(
    isTuiAgent(agent)
      ? projectAgentLaunchProfile(
          agent,
          { ...settings, agentLaunchChoices: undefined },
          { target: 'structured', shell }
        ).args
      : resolveTuiAgentLaunchArgs(agent, settings),
    shell
  )
  if (!parsed.ok) {
    throw new Error(`${agent} Arguments are invalid: ${parsed.error}`)
  }
  return parsed.tokens
}
