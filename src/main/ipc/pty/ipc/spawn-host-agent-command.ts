import {
  hasHostResolvedCommand,
  resolveHostAgentTerminalCommand
} from '../../../runtime/terminal/launch/host-agent-terminal-command-resolution'
import { resolveStartupShell } from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/windows-terminal-shell'
import type { PtyIpcSpawnState } from './spawn-state'

export async function preparePtyIpcHostAgentCommand(ctx: PtyIpcSpawnState): Promise<void> {
  // Adopted owners and pane launch plans already determine their own runtime command.
  if (
    ctx.preAdoptedStablePane ||
    ctx.paneAgentLaunch ||
    !hasHostResolvedCommand(ctx.args.launchAgent)
  ) {
    return
  }
  const connectionId = ctx.args.connectionId
  const isWsl = ctx.codexSelectionTarget.runtime === 'wsl'
  const platform = connectionId || isWsl ? 'linux' : process.platform
  const launch = await resolveHostAgentTerminalCommand(
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
          terminalWindowsShell: ctx.effectiveShellOverride
        })
      )
    }
  )
  ctx.launchCommand = launch.command
  ctx.effectiveLaunchConfig = launch.launchConfig
}
