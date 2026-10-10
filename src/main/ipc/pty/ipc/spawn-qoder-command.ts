import { resolveQoderTerminalCommand } from '../../../runtime/qoder-terminal-command-resolution'
import { resolveStartupShell } from '../../../../shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/windows-terminal-shell'
import type { PtyIpcSpawnState } from './spawn-state'

export async function preparePtyIpcQoderCommand(ctx: PtyIpcSpawnState): Promise<void> {
  if (ctx.preAdoptedStablePane || ctx.args.launchAgent !== 'qoder') {
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
          terminalWindowsShell: ctx.effectiveShellOverride
        })
      )
    }
  )
  ctx.launchCommand = launch.command
  ctx.effectiveLaunchConfig = launch.launchConfig
}
