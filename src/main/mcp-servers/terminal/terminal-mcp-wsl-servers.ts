// The host list's servers for an agent in a WSL distro. The guest can't reach Windows loopback, and
// its `orca` is a bridge to the Windows CLI, so a server that needs Orca goes through that CLI:
// - one through the relay (saved headers, Orca's sign-in, or a shared process) runs as
//   `orca mcp connect`, which bridges its stdio to the relay on Windows;
// - a command server with saved env runs in the guest, under a wrapper that reads the env from
//   `orca mcp env` over a pipe and execs the command, so no value sits on argv or in history.
import type { BotToolServer } from '../../../shared/bot-tools'
import { mcpEnvWrapperCommand } from '../../../shared/mcp-servers/mcp-env-pairs'
import { getAppEnvironment, hasAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { join } from 'node:path'
import { getManagedWslCliDir, getWslCliCommandName } from '../../cli/wsl/wsl-managed-cli'
import type { McpLaunchEntry } from '../mcp-host-list-launch'
import { settleWslAutomountRoot } from '../../wsl/filesystem/wsl-automount-root'
import { wslGuestDrivePath } from './terminal-mcp-launch-files'

/** Each data folder's managed WSL launcher (a Windows path), resolved once per run: its files are
 *  named by their content, so they don't move while Orca runs. */
const launchers = new Map<string, string | null>()

function managedWslLauncher(): string | null {
  if (!hasAppEnvironment()) {
    return null
  }
  const app = getAppEnvironment()
  const userDataPath = app.getPath('userData')
  if (!launchers.has(userDataPath)) {
    const dir = getManagedWslCliDir({
      isPackaged: app.isPackaged(),
      userDataPath,
      ...(process.resourcesPath ? { resourcesPath: process.resourcesPath } : {})
    })
    launchers.set(userDataPath, dir ? join(dir, getWslCliCommandName(app.isPackaged())) : null)
  }
  return launchers.get(userDataPath) ?? null
}

/** Reads where `distro` mounts Windows drives when not yet read since it started; a failed read
 *  leaves the default (`/mnt/`), and the launch goes on. */
export async function settleWslMountRoot(distro: string | null): Promise<void> {
  if (distro === null) {
    return
  }
  await settleWslAutomountRoot(distro)?.catch((error: unknown) => {
    console.warn(`[mcp-servers] ${String(error)}; guest paths assume /mnt/`)
  })
}

/** The guest path of this Orca's `orca` launcher for `distro`; null when it has none there. */
export function wslGuestOrcaLauncher(distro: string | null): string | null {
  const launcher = managedWslLauncher()
  return launcher ? wslGuestDrivePath(distro, launcher) : null
}

export type WslServerLaunch = {
  agent: string
  workspaceId: string | null
  /** The guest launcher (`wslGuestOrcaLauncher`); null leaves out every server that needs Orca. */
  launcher: string | null
}

/** `orca mcp connect <id>` in the guest, naming the launch's workspace outright as the env wrapper
 *  does, so both resolve it the same way (mcp-caller-workspace.ts). */
export function wslConnectServer(
  entry: McpLaunchEntry,
  launch: WslServerLaunch
): BotToolServer | null {
  if (!entry.id || !launch.launcher) {
    return null
  }
  return {
    name: entry.server.name,
    command: launch.launcher,
    args: [
      'mcp',
      'connect',
      entry.id,
      '--agent',
      launch.agent,
      ...(launch.workspaceId ? ['--workspace', launch.workspaceId] : ['--outside-workspace'])
    ]
  }
}

/** What an agent that starts its servers with a trimmed environment must pass on for the guest's
 *  `orca` to reach Windows: the interop socket, and the distro its bridge names. */
export const WSL_INTEROP_ENV = ['WSL_INTEROP', 'WSL_DISTRO_NAME'] as const

/** The command server in the guest, its saved env read from this Orca by the wrapper. */
export function wslSavedEnvServer(
  entry: McpLaunchEntry,
  launch: WslServerLaunch
): BotToolServer | null {
  const { server } = entry
  if ('url' in server || !entry.id || !launch.launcher) {
    return null
  }
  return {
    name: server.name,
    ...mcpEnvWrapperCommand(
      {
        launcher: launch.launcher,
        id: entry.id,
        agent: launch.agent,
        workspaceId: launch.workspaceId
      },
      server
    )
  }
}
