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
import { recognizeAgentLaunchCommand } from '../../../../shared/agent-launch/startup/agent-command-line-intent'
import { readLaunchPosition } from '../../../../shared/agent-launch/startup/launch-position'
import { GENERATED_AGENT_LAUNCH_ENV } from '../../../../shared/agent-launch/startup/generated-agent-launch-inputs'
import {
  ORCA_HERMES_STARTUP_QUERY_ARGV_ENV,
  ORCA_HERMES_STARTUP_QUERY_ENV
} from '../../../../shared/agent-launch/startup/hermes-startup-query'
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
  let paneEnv = input.env
  if (
    paneEnv &&
    (GENERATED_AGENT_LAUNCH_ENV in paneEnv || ORCA_HERMES_STARTUP_QUERY_ARGV_ENV in paneEnv)
  ) {
    paneEnv = { ...paneEnv }
    delete paneEnv[GENERATED_AGENT_LAUNCH_ENV]
    delete paneEnv[ORCA_HERMES_STARTUP_QUERY_ARGV_ENV]
    if (blocked) {
      delete paneEnv[ORCA_HERMES_STARTUP_QUERY_ENV]
    }
  }
  const openCodeLaunch = await prepareOpenCodePtyLaunch({
    command: startupCommand,
    agent: launchAgent,
    env: paneEnv,
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
  const local = !connectionId && input.codexRuntime !== 'wsl'
  const root = local && process.getuid?.() === 0
  const authored = launchConfig?.commandProvenance === 'authored'
  const recordedCommand = launchConfig?.agentCommand
  const configuredCommand =
    launchAgent === 'claude' || launchAgent === 'claude-agent-teams'
      ? (settings?.agentCmdOverrides?.[launchAgent] ?? settings?.agentCmdOverrides?.claude)
      : undefined
  const authoredCommand =
    launchConfig?.authoredCommand ??
    (configuredCommand && recordedCommand?.startsWith(configuredCommand)
      ? configuredCommand
      : undefined)
  const authoredLaunch = authored && root && authoredCommand ? openCodeLaunch.command : undefined
  const cwdLaunch =
    authoredLaunch && shell === 'posix' && /^cd[ \t]/.test(authoredLaunch)
      ? readLaunchPosition(authoredLaunch, shell)
      : null
  const cwdEnd =
    authoredLaunch && cwdLaunch?.cwd
      ? authoredLaunch.lastIndexOf('&&', cwdLaunch.invocationStart)
      : -1
  const commandStart = cwdEnd < 0 ? 0 : cwdEnd + 3
  const agentAfterCwd = authoredLaunch?.slice(commandStart)
  const authoredPrefix =
    authoredCommand &&
    !agentAfterCwd?.startsWith(authoredCommand) &&
    launchAgent === 'claude-agent-teams'
      ? [
          addClaudeTeammateModeAuto(authoredCommand),
          addClaudeTeammateModeInProcess(authoredCommand)
        ].find((command) => agentAfterCwd?.startsWith(command))
      : authoredCommand
  const authoredRootLaunch =
    authored && authoredPrefix
      ? planClaudeRootLaunch({
          command: agentAfterCwd,
          agent: launchAgent,
          shell,
          isRoot: root,
          env: [env, process.env],
          authoredPrefix
        })
      : null
  const beforeTeams = authoredRootLaunch
    ? (authoredLaunch?.slice(0, commandStart) ?? '') + authoredRootLaunch.command
    : openCodeLaunch.command
  const inlineImagesEnabled = applyTerminalImageEnvironment(
    env,
    input.envToDelete,
    launchAgent,
    settings?.terminalInlineImages,
    input.headlessHost
  )
  const pickerTeams =
    launchAgent === 'claude-agent-teams' &&
    Boolean(launchConfig?.commandProvenance) &&
    recognizeAgentLaunchCommand(beforeTeams)?.agent !== 'claude-agent-teams'
  const teamsCommand =
    pickerTeams && beforeTeams
      ? env.ORCA_AGENT_TEAMS_TEAM_ID
        ? addClaudeTeammateModeAuto(beforeTeams)
        : addClaudeTeammateModeInProcess(beforeTeams)
      : beforeTeams
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
  const rootLaunch = planClaudeRootLaunch({
    command: viewedCommand,
    agent: launchAgent,
    shell,
    isRoot: root && !authored,
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
    startupNotice: authoredRootLaunch?.notice ?? rootLaunch?.notice,
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
