import type { AgentSessionHandleProvider } from '../../shared/agent-session-provider-handle'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolveTuiAgentLaunchArgs } from '../../shared/tui-agent-launch-defaults'
import { tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'

/** Use the same grouping rules as terminal launches before the provider filters its owned flags. */
export function structuredAgentConfiguredArgs(
  agent: AgentSessionHandleProvider,
  settings: Partial<Pick<GlobalSettings, 'agentDefaultArgs' | 'terminalWindowsShell'>>,
  platform: NodeJS.Platform = process.platform
): string[] {
  const shell =
    resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote: false,
      terminalWindowsShell: settings.terminalWindowsShell
    }) ?? 'posix'
  const parsed = tokenizeStartupCommand(
    resolveTuiAgentLaunchArgs(agent, settings.agentDefaultArgs),
    shell
  )
  if (!parsed.ok) {
    throw new Error(`${agent} Arguments are invalid: ${parsed.error}`)
  }
  return parsed.tokens
}
