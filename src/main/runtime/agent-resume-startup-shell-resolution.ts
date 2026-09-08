import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'

/**
 * Startup shell for a host-authority agent resume.
 *
 * A client may report the shell its pane actually runs, which is the only way a
 * per-tab override reaches the host (#12320, #13095). That report describes one
 * local native-Windows pane, so it is honoured only for a local win32 target:
 * accepting it for a remote or non-Windows target would let a request pick a
 * quoting mode the target shell does not use. Every other case keeps the host's
 * own resolution from the global `terminalWindowsShell` setting.
 */
export function resolveAgentResumeStartupShell(args: {
  requestedStartupShell?: AgentStartupShell
  platform: NodeJS.Platform
  isRemote: boolean
  terminalWindowsShell?: string | null
}): AgentStartupShell | undefined {
  const hostShell = resolveLocalWindowsAgentStartupShell({
    platform: args.platform,
    isRemote: args.isRemote,
    terminalWindowsShell: args.terminalWindowsShell
  })
  if (args.platform !== 'win32' || args.isRemote) {
    return hostShell
  }
  return args.requestedStartupShell ?? hostShell
}
