import {
  addClaudeTeammateModeAuto,
  addClaudeTeammateModeInProcess
} from '../../../../shared/agent-launch/startup/claude-agent-teams-tmux-compat'
import { planClaudeRootLaunch } from '../../../../shared/agent-launch/permissions/claude-root-bypass-launch'
import { withClaudeAgentViewPlugin } from '../../../../shared/agent-hook-listener/providers/claude/view/claude-agent-view-launch'
import {
  clearEnvCommand,
  commandSeparator
} from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { recognizeAgentLaunchCommand } from '../../../../shared/agent-launch/startup/agent-command-line-intent'
import { readLaunchPosition } from '../../../../shared/agent-launch/startup/launch-position'
import { hermesStartupQueryFits } from '../../../../shared/agent-launch/startup/hermes-startup-query'
import { agentLaunchUnbuildableMessage } from '../../../../shared/agent-launch/startup/tui-agent-startup'
import type { AgentProgramBlockReason } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  RECEIVING_SHELL_LAUNCH_ENV,
  receivingShellLaunchFromEnv,
  renderReceivingShellLaunch
} from '../../../../shared/agent-launch/startup/receiving-shell-agent-launch'
import {
  hasControlByte,
  TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES
} from '../../../../shared/agent-launch/startup/startup-line-prompt-carry'
import {
  buildSetupAgentRecheck,
  setupAgentBlockedNotice,
  SETUP_AGENT_NOTICE_ENV,
  SETUP_AGENT_RECHECK_ENV,
  SETUP_AGENT_RUNTIME_ROOT_ENV
} from '../../../../shared/agent-launch/startup/setup-agent-program'
import { getRuntimeDesktopSurface } from '../../../runtime/construction/runtime-desktop-surface'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/agent-launch/catalog/tui-agent-display-names'
import { nativeWindowsPathToPosixShellPath } from '../../../../shared/agent-launch/startup/setup-runner-command'
import {
  SETUP_AGENT_PROMPT_ENV,
  SETUP_AGENT_SEQUENCE_POWERSHELL_SCRIPT_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV
} from '../../../../shared/agent-launch/startup/setup-agent-sequencing'
import { withSpawnTerminalMcpServers } from '../../../mcp-servers/terminal/terminal-mcp-spawn-step'
import { getOrcaAgentRuntimeRoot } from '../../../managed-agent-cli/managed-agent-cli-path'
import { promoteAgentTeamsShimPath } from '../host-env/path'
import { addSetupAgentWslInteropEnv } from '../../../pty/shell-startup/wsl-orca-env'
import type { PtySpawnLaunchOptionsInput } from './spawn-options-assembly'
import type { selectPtyAgentLaunch } from './select-pty-agent-launch'
import { applyTerminalImageEnvironment } from './terminal-image-environment'
import { prepareDirectLaunch } from './prepare-direct-agent-launch'
import { preparePostSetupCommand } from './prepare-post-setup-agent-command'

export async function preparePtyAgentLaunch(
  input: PtySpawnLaunchOptionsInput,
  selection: Awaited<ReturnType<typeof selectPtyAgentLaunch>>,
  openCodeLaunch: { command: string | undefined; env: Record<string, string> | undefined }
) {
  const { args } = input
  const connectionId = args.connectionId ?? undefined
  const {
    launchAgent,
    shell,
    paneShell,
    platform,
    sequenced,
    launchConfig,
    selectionBlocked,
    rebuiltHermesQuery,
    postSetupProgram,
    receivingShellCheck
  } = selection
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
    connectionId,
    postSetupProgram
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
  let agentCommand = rootLaunch?.command ?? viewedCommand
  const images = inlineImagesEnabled && !input.envToDelete.includes('KITTY_WINDOW_ID')
  let prepared = agentCommand
  if (sequenced) {
    delete env[SETUP_AGENT_NOTICE_ENV]
    delete env[SETUP_AGENT_RECHECK_ENV]
    delete env[SETUP_AGENT_RUNTIME_ROOT_ENV]
  }
  if (postSetupProgram && shell !== 'cmd') {
    const runtimeRoot = getOrcaAgentRuntimeRoot()
    env[SETUP_AGENT_RUNTIME_ROOT_ENV] =
      runtimeRoot && local && process.platform === 'win32' && shell === 'posix'
        ? nativeWindowsPathToPosixShellPath(runtimeRoot)
        : (runtimeRoot ?? '')
    env[SETUP_AGENT_RECHECK_ENV] = buildSetupAgentRecheck(postSetupProgram, shell)
    env[SETUP_AGENT_NOTICE_ENV] = setupAgentBlockedNotice(
      TUI_AGENT_DISPLAY_NAMES[postSetupProgram.agent],
      getRuntimeDesktopSurface().translateNotification
    )
    if (input.codexRuntime === 'wsl') {
      addSetupAgentWslInteropEnv(env)
    }
    if (postSetupProgram.blocked) {
      prepared = undefined
    } else if (prepared && !rebuiltHermesQuery) {
      prepared = await preparePostSetupCommand(prepared, postSetupProgram, shell, images)
    }
  } else if (
    !connectionId &&
    !args.nativeChatSignIn &&
    prepared !== undefined &&
    (authored || launchConfig?.commandProvenance === 'generated')
  ) {
    prepared = await prepareDirectLaunch(
      prepared,
      shell,
      input,
      env,
      local,
      images,
      authored,
      receivingShellCheck
    )
  } else if (receivingShellCheck && agentCommand !== undefined && prepared !== undefined) {
    prepared = await renderReceivingShellLaunch(receivingShellCheck, agentCommand, prepared)
  }
  promoteAgentTeamsShimPath(env, input.requestedAgentTeamsPath)
  // Setup gates carry the wrapper in the environment, where it is counted once.
  const hermesQueryTooLarge =
    rebuiltHermesQuery &&
    prepared !== undefined &&
    !hermesStartupQueryFits(
      sequenced ? '' : prepared,
      sequenced ? { ...env, [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: prepared } : env,
      platform
    )
  const blocked: AgentProgramBlockReason | undefined = hermesQueryTooLarge
    ? 'unbuildable'
    : selectionBlocked
  if (hermesQueryTooLarge) {
    agentCommand = undefined
    prepared = undefined
  }
  if (blocked || (postSetupProgram && !prepared)) {
    for (const key of SETUP_AGENT_PROMPT_ENV) {
      delete env[key]
      if (!input.envToDelete.includes(key)) {
        input.envToDelete.push(key)
      }
    }
  }
  const keepGate = sequenced && !blocked
  if (sequenced) {
    if (!keepGate) {
      delete env[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]
      delete env[SETUP_AGENT_SEQUENCE_POWERSHELL_SCRIPT_ENV]
    }
    if (prepared === undefined) {
      delete env[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]
    } else {
      env[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV] = prepared
    }
  }
  let startup = keepGate ? input.launchCommand : prepared
  if (
    !sequenced &&
    !input.preAdoptedStablePane &&
    receivingShellCheck &&
    startup !== undefined &&
    (Buffer.byteLength(startup) > TYPED_STARTUP_LINE_PROMPT_BUDGET_BYTES || hasControlByte(startup))
  ) {
    env[RECEIVING_SHELL_LAUNCH_ENV] = startup
    startup = receivingShellLaunchFromEnv(receivingShellCheck.shell)
  }
  return {
    env,
    launchAgent: blocked ? undefined : launchAgent,
    launchConfig,
    blocked,
    launchCommand: sequenced && !blocked ? input.launchCommand : agentCommand,
    startup:
      startup && keepGate && postSetupProgram
        ? startup + commandSeparator(paneShell) + clearEnvCommand(SETUP_AGENT_PROMPT_ENV, paneShell)
        : startup,
    settings,
    startupNotice: hermesQueryTooLarge
      ? `\r\n[orca] ${agentLaunchUnbuildableMessage('hermes')}\r\n`
      : (authoredRootLaunch?.notice ?? rootLaunch?.notice),
    terminalMcp: mcp.pane
  }
}
