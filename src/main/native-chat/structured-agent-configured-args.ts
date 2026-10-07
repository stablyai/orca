import type { AgentSessionHandleProvider } from '../../shared/agent-session-provider-handle'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'

/**
 * The user's extra Arguments, grouped by the same rules as terminal launches. The permission
 * mode is not here: structured chat applies it through its own SDK/app-server policy.
 */
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
  const parsed = tokenizeStartupCommand(settings.agentDefaultArgs?.[agent] ?? '', shell)
  if (!parsed.ok) {
    throw new Error(`${agent} Arguments are invalid: ${parsed.error}`)
  }
  return parsed.tokens
}
