// Claude Code takes servers for one run from a 0600 file passed as `--mcp-config=<path>`, as a plain
// `claude` terminal or an Agent Teams lead started by `orca claude-teams`.
import { claudeServerConfig } from '../../bots/bot-tools-claude'
import {
  claudeRefusesMcpConfig,
  launchFilePath,
  NOT_PLAIN,
  platformOf,
  skip,
  withArgs,
  type TerminalMcpAdapter,
  type TerminalMcpDelivery,
  type TerminalMcpLaunch
} from './terminal-mcp-delivery'

async function deliverToClaude(
  adapter: TerminalMcpAdapter,
  launch: TerminalMcpLaunch,
  executable: string
): Promise<TerminalMcpDelivery> {
  if (await claudeRefusesMcpConfig(launch, executable)) {
    return skip('Claude Code’s organization settings refuse --mcp-config', true)
  }
  const platform = platformOf(launch)
  const mcpServers = Object.fromEntries(
    launch.servers.map((server) => [server.name, claudeServerConfig(server, platform)])
  )
  const path = await launchFilePath(launch, 'claude', { mcpServers })
  // One token: --mcp-config takes every value after it, so a prompt after it would be read as one.
  const command =
    path &&
    withArgs(launch, adapter.executables, [`--mcp-config=${path}`], adapter.launcher?.subcommand)
  return command ? { delivered: true, command, tokenInEnv: true } : skip(NOT_PLAIN)
}

export const claude: TerminalMcpAdapter = {
  agent: 'claude',
  executables: ['claude'],
  wsl: true,
  deliver(launch, executable) {
    return deliverToClaude(this, launch, executable)
  }
}

/** `orca claude-teams` passes its args on to the lead's `claude`, which replays --mcp-config on each
 *  teammate's command line; the relay env reaches teammates through the team's env. */
export const claudeAgentTeams: TerminalMcpAdapter = {
  agent: 'claude',
  executables: ['orca', 'orca-dev', 'orca-ide'],
  launcher: { subcommand: 'claude-teams', runs: 'claude' },
  // Agent Teams runs in neither WSL nor Windows (tui-agent-config.ts).
  wsl: false,
  deliver(launch, executable) {
    return deliverToClaude(this, launch, executable)
  }
}
