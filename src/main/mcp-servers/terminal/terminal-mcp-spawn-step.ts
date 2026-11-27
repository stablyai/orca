// The spawn assembly's MCP step, for both spawn lanes (window and runtime).
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { SetupAgentProgram } from '../../../shared/agent-launch/startup/setup-agent-program'
import type { AgentStartupShell } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { withTerminalMcpServers, type TerminalMcpPaneLaunch } from './terminal-mcp-launch'

/** Adds the host's servers to the prepared agent command, including launches held by a setup gate. */
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
    postSetupProgram?: SetupAgentProgram
  }
): Promise<{ command: string | undefined; pane: TerminalMcpPaneLaunch | null }> {
  const program = launch.postSetupProgram
  return withTerminalMcpServers({
    launchAgent: launch.launchAgent ?? (program?.path ? program.agent : undefined),
    command: launch.command,
    env: launch.env,
    envToDelete: spawn.envToDelete,
    shell: launch.shell,
    cwd: spawn.cwd,
    worktreeId: spawn.args.worktreeId,
    connectionId: launch.connectionId,
    executableUnverified: program !== undefined && program.path === undefined,
    verifiedExecutable: program?.path,
    isFreshLaunch: !spawn.preAdoptedStablePane && spawn.launchCommand !== undefined,
    ...(spawn.codexRuntime === 'wsl' ? { wsl: { distro: spawn.expectedWslDistro } } : {}),
    codexHome: spawn.selectedCodexHomePath
  })
}
