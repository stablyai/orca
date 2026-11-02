import { withClaudeAgentViewPlugin } from '../../../shared/claude-agent-view-launch'
import {
  resolveStartupShell,
  type AgentStartupShell
} from '../../../shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import { planCodexNoDaemonLaunch } from '../../pty/codex-no-daemon-launch-command'

/** The shell that quotes an agent launch on this host. */
export function resolveAgentLaunchShell(
  isRemote: boolean,
  isWsl: boolean,
  terminalWindowsShell: string | null | undefined
): AgentStartupShell {
  return resolveStartupShell(
    isWsl ? 'linux' : process.platform,
    resolveLocalWindowsAgentStartupShell({
      platform: process.platform,
      isRemote,
      terminalWindowsShell
    })
  )
}

/** Wrappers every agent launch command gets after its environment is prepared; `command` is
 *  null when the no-daemon probe does not apply, keeping the common path synchronous. */
export function decorateAgentLaunchCommand(input: {
  command: string | undefined
  env: Record<string, string> | undefined
  envToDelete: readonly string[]
  cwd: string | undefined
  shell: AgentStartupShell
  connectionId: string | undefined
  executesOnThisHost: boolean
  shellOverride: string | undefined
}): { launchCommand: string | undefined; command: Promise<string> | null } {
  const pluginDir = !input.connectionId ? input.env?.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR : undefined
  const launchCommand =
    pluginDir && input.command
      ? withClaudeAgentViewPlugin(input.command, pluginDir, input.shell)
      : input.command
  return {
    launchCommand,
    command: planCodexNoDaemonLaunch({
      command: launchCommand,
      executesOnThisHost: input.executesOnThisHost,
      shellOverride: input.shellOverride,
      env: input.env,
      envToDelete: input.envToDelete,
      cwd: input.cwd
    })
  }
}
