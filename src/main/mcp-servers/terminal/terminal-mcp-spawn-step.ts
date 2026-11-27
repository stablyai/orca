// The spawn assembly's MCP step, for both spawn lanes (window and runtime).
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { AgentStartupShell } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../../shared/agent-launch/startup/setup-agent-sequencing'
import { withTerminalMcpServers, type TerminalMcpPaneLaunch } from './terminal-mcp-launch'

/**
 * The spawn assembly's step: the pane's command with the host list's servers, or the command as it
 * was. A launch after a setup script runs the agent's command from its variable, so that is where
 * the servers go then.
 */
export async function withSpawnTerminalMcpServers(
  spawn: {
    args: { worktreeId?: string }
    envToDelete: string[]
    cwd: string | undefined
    preAdoptedStablePane: boolean
    launchCommand: string | undefined
    codexRuntime: 'host' | 'wsl' | undefined
    expectedWslDistro: string | null
    selectedCodexHomePath: string | null
  },
  launch: {
    launchAgent: TuiAgent | undefined
    command: string | undefined
    env: Record<string, string>
    shell: AgentStartupShell
    connectionId: string | undefined
  }
): Promise<{ command: string | undefined; pane: TerminalMcpPaneLaunch | null }> {
  const sequenced = launch.env[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]
  const result = await withTerminalMcpServers({
    launchAgent: launch.launchAgent,
    command: sequenced ?? launch.command,
    env: launch.env,
    envToDelete: spawn.envToDelete,
    shell: launch.shell,
    cwd: spawn.cwd,
    worktreeId: spawn.args.worktreeId,
    connectionId: launch.connectionId,
    isFreshLaunch: !spawn.preAdoptedStablePane && spawn.launchCommand !== undefined,
    ...(spawn.codexRuntime === 'wsl' ? { wsl: { distro: spawn.expectedWslDistro } } : {}),
    codexHome: spawn.selectedCodexHomePath
  })
  if (sequenced === undefined) {
    return result
  }
  if (result.command !== undefined && result.command !== sequenced) {
    launch.env[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV] = result.command
  }
  return { command: launch.command, pane: result.pane }
}
