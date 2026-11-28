import { resolveQoderTerminalCommand } from '../../../runtime/terminal/launch/qoder-terminal-command-resolution'
import { isConfiguredGitBashAvailable } from '../../../pty/shell-startup/git-bash'
import { resolveStartupShell } from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/shell/launch/windows-terminal-shell'
import type { PtyIpcSpawnState } from './spawn-state'

export async function preparePtyIpcQoderCommand(ctx: PtyIpcSpawnState): Promise<void> {
  // Adopted owners and pane launch plans already determine their own runtime command.
  if (ctx.preAdoptedStablePane || ctx.paneAgentLaunch || ctx.args.launchAgent !== 'qoder') {
    return
  }
  const connectionId = ctx.args.connectionId
  const isWsl = ctx.codexSelectionTarget.runtime === 'wsl'
  const platform = connectionId || isWsl ? 'linux' : process.platform
  const launch = await resolveQoderTerminalCommand(
    {
      launchAgent: ctx.args.launchAgent,
      command: ctx.launchCommand,
      launchConfig: ctx.effectiveLaunchConfig
    },
    {
      connectionId,
      context: connectionId ? undefined : { wslDistro: ctx.expectedWslDistro, wslDefault: isWsl },
      shell: resolveStartupShell(
        platform,
        resolveLocalWindowsAgentStartupShell({
          platform,
          isRemote: Boolean(connectionId),
          terminalWindowsShell: ctx.effectiveShellOverride,
          gitBashAvailable:
            !connectionId && platform === 'win32'
              ? isConfiguredGitBashAvailable(ctx.effectiveShellOverride)
              : undefined
        })
      )
    }
  )
  ctx.launchCommand = launch.command
  ctx.effectiveLaunchConfig = launch.launchConfig
}
