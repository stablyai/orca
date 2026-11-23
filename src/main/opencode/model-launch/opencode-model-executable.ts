import {
  readLaunchArguments,
  readLaunchPosition
} from '../../../shared/agent-launch/startup/launch-position'
import {
  resolveStartupShell,
  type AgentStartupShell
} from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { resolveCommandOnLocalPath } from '../../ipc/command-path/command-path-resolver'

export async function resolveOpenCodeDirectModelExecutable(options: {
  command: string | undefined
  env: NodeJS.ProcessEnv
  cwd?: string
  shell?: AgentStartupShell
  wsl?: { distro?: string }
}): Promise<string | null> {
  // WSL needs the same guest account/profile environment as its actual launch.
  if (options.wsl || !options.cwd) {
    return null
  }
  const shell = resolveStartupShell(process.platform, options.shell)
  const command = options.command ?? ''
  const launch = readLaunchPosition(command, shell)
  if (
    !launch ||
    launch.cwd ||
    launch.env.size ||
    launch.bypassesShellFunction ||
    readLaunchArguments(command, shell, launch)?.length !== 0
  ) {
    return null
  }
  return resolveCommandOnLocalPath(launch.executable, {
    env: options.env,
    cwd: options.cwd
  })
}
