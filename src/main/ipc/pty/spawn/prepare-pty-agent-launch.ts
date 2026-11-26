import {
  addClaudeTeammateModeAuto,
  addClaudeTeammateModeInProcess
} from '../../../../shared/agent-launch/startup/claude-agent-teams-tmux-compat'
import { planClaudeRootLaunch } from '../../../../shared/agent-launch/permissions/claude-root-bypass-launch'
import { withClaudeAgentViewPlugin } from '../../../../shared/agent-hook-listener/providers/claude/view/claude-agent-view-launch'
import {
  resolveStartupShell,
  type AgentStartupShell
} from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/shell/launch/windows-terminal-shell'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import {
  readCodexDirectLaunch,
  withCodexDirectLaunchCommand
} from '../../../../shared/agent-launch/startup/codex-startup-image-command'
import { withClaudeDirectLaunchCommand } from '../../../../shared/agent-launch/startup/claude-direct-launch-command'
import {
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV
} from '../../../../shared/agent-launch/startup/setup-agent-sequencing'
import { alignManagedAgentLaunchAtSpawn } from '../../../managed-agent-cli/managed-agent-spawn-program'
import { withSpawnTerminalMcpServers } from '../../../mcp-servers/terminal/terminal-mcp-spawn-step'
import { prepareOpenCodePtyLaunch } from '../../../opencode/opencode-pty-launch'
import { planCodexNoDaemonLaunch } from '../../../pty/shell-startup/codex-no-daemon-launch-command'
import type { PtySpawnLaunchOptionsInput } from './spawn-options-assembly'
import { applyTerminalImageEnvironment } from './terminal-image-environment'

export async function preparePtyAgentLaunch(input: PtySpawnLaunchOptionsInput) {
  const { args } = input
  const connectionId = args.connectionId ?? undefined
  const launchAgent = isTuiAgent(args.launchAgent) ? args.launchAgent : undefined
  const paneShell = resolveStartupShell(
    input.codexRuntime === 'wsl' ? 'linux' : process.platform,
    resolveLocalWindowsAgentStartupShell({
      platform: process.platform,
      isRemote: Boolean(connectionId) || input.codexRuntime === 'wsl',
      terminalWindowsShell: input.shellOverride ?? input.getSettings?.()?.terminalWindowsShell
    })
  )
  // The setup gate's existing carrier holds the actual launch, including any Agent Teams flags.
  const sequenced = input.launchCommand && input.env?.[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]
  const shell = sequenced
    ? input.env?.[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]
      ? 'posix'
      : 'powershell'
    : paneShell
  const command = sequenced || input.launchCommand
  const {
    command: startupCommand,
    launchConfig,
    blocked
  } = await alignManagedAgentLaunchAtSpawn(
    {
      ...input,
      launchCommand: command,
      launchAgent,
      restoring: Boolean(args.resumeProviderSession) || args.resumeOrigin === 'saved',
      nativeChatSignIn: args.nativeChatSignIn,
      sshTarget: Boolean(connectionId),
      ...(sequenced ? { sourceShell: paneShell } : {})
    },
    shell
  )
  const openCodeLaunch = await prepareOpenCodePtyLaunch({
    command: startupCommand,
    agent: launchAgent,
    env: input.env,
    envToDelete: input.envToDelete,
    cwd: input.cwd,
    connectionId,
    isFreshLaunch: !input.preAdoptedStablePane && startupCommand !== undefined,
    shell,
    ...(input.codexRuntime === 'wsl'
      ? { wsl: { distro: input.expectedWslDistro ?? undefined } }
      : {})
  })
  const settings = input.getSettings?.()
  const env = { ...openCodeLaunch.env }
  const inlineImagesEnabled = applyTerminalImageEnvironment(
    env,
    input.envToDelete,
    launchAgent,
    settings?.terminalInlineImages,
    input.headlessHost
  )
  const pickerTeams =
    launchAgent === 'claude-agent-teams' && Boolean(launchConfig?.commandProvenance)
  const teamsCommand =
    pickerTeams && openCodeLaunch.command
      ? env.ORCA_AGENT_TEAMS_TEAM_ID
        ? addClaudeTeammateModeAuto(openCodeLaunch.command)
        : addClaudeTeammateModeInProcess(openCodeLaunch.command)
      : openCodeLaunch.command
  if (pickerTeams && teamsCommand) {
    env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
  }
  const mcp = await withSpawnTerminalMcpServers(input, {
    launchAgent: pickerTeams ? 'claude' : launchAgent,
    command: teamsCommand,
    env,
    shell,
    connectionId
  })
  const pluginDir = !connectionId ? env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR : undefined
  const viewedCommand =
    pluginDir && mcp.command
      ? withClaudeAgentViewPlugin(mcp.command, pluginDir, shell)
      : mcp.command
  const local = !connectionId && input.codexRuntime !== 'wsl'
  const rootLaunch = planClaudeRootLaunch({
    command: viewedCommand,
    agent: launchAgent,
    shell,
    isRoot: local && process.getuid?.() === 0,
    env: [env, process.env]
  })
  const agentCommand = rootLaunch?.command ?? viewedCommand
  const images = inlineImagesEnabled && !input.envToDelete.includes('KITTY_WINDOW_ID')
  const prepared =
    connectionId ||
    args.nativeChatSignIn ||
    agentCommand === undefined ||
    launchConfig?.commandProvenance !== 'generated'
      ? agentCommand
      : await prepareDirectLaunch(agentCommand, shell, input, env, local, images)
  if (sequenced) {
    if (prepared === undefined) {
      delete env[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]
    } else {
      env[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV] = prepared
    }
  }
  return {
    env,
    launchAgent: blocked ? undefined : launchAgent,
    launchConfig,
    blocked,
    launchCommand: sequenced && !blocked ? input.launchCommand : agentCommand,
    startup: sequenced && !blocked ? input.launchCommand : prepared,
    settings,
    startupNotice: rootLaunch?.notice,
    terminalMcp: mcp.pane
  }
}

async function prepareDirectLaunch(
  command: string,
  shell: AgentStartupShell,
  input: PtySpawnLaunchOptionsInput,
  env: NodeJS.ProcessEnv,
  local: boolean,
  images: boolean
): Promise<string> {
  const invocation = readCodexDirectLaunch(command, shell)
  if (!invocation) {
    return withClaudeDirectLaunchCommand(command, shell)
  }
  const supported = await planCodexNoDaemonLaunch(
    {
      command,
      executesOnThisHost: local,
      env,
      envToDelete: input.envToDelete,
      cwd: input.cwd
    },
    shell,
    invocation
  )
  const { end } = invocation.launch
  return withCodexDirectLaunchCommand(
    supported ? `${command.slice(0, end)} --no-daemon${command.slice(end)}` : command,
    shell,
    { images, probeInShell: !local },
    supported && invocation.args
      ? { ...invocation, args: ['--no-daemon', ...invocation.args] }
      : invocation
  )
}
