// Why: extracted from ssh.ts to keep the main IPC module under the max-lines
// threshold. These helpers manage relay lifecycle (cleanup, event wiring,
// reconnection) and are called from both initial connect and reconnection paths.

import type { BrowserWindow } from 'electron'
import { deployAndLaunchRelay } from '../ssh/ssh-relay-deploy'
import { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { SshPtyProvider } from '../providers/ssh-pty-provider'
import { SshFilesystemProvider } from '../providers/ssh-filesystem-provider'
import { SshGitProvider } from '../providers/ssh-git-provider'
import { registerSshPtyProvider, unregisterSshPtyProvider, getPtyIdsForConnection } from './pty'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import type { SshPortForwardManager } from '../ssh/ssh-port-forward'
import type { SshConnectionManager } from '../ssh/ssh-connection'

export function cleanupConnection(
  targetId: string,
  activeMultiplexers: Map<string, SshChannelMultiplexer>,
  initializedConnections: Set<string>,
  portForwardManager: SshPortForwardManager | null
): void {
  portForwardManager?.removeAllForwards(targetId)
  const mux = activeMultiplexers.get(targetId)
  if (mux) {
    mux.dispose()
    activeMultiplexers.delete(targetId)
  }
  unregisterSshPtyProvider(targetId)
  unregisterSshFilesystemProvider(targetId)
  unregisterSshGitProvider(targetId)
  initializedConnections.delete(targetId)
}

// Why: extracted so both initial connect and reconnection use the same wiring.
// Forgetting to wire PTY events on reconnect would cause silent terminal death.
export function wireUpSshPtyEvents(
  ptyProvider: SshPtyProvider,
  getMainWindow: () => BrowserWindow | null
): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    ptyProvider.onData((payload) => {
      if (!win.isDestroyed()) {
        win.webContents.send('pty:data', payload)
      }
    })
    ptyProvider.onExit((payload) => {
      if (!win.isDestroyed()) {
        win.webContents.send('pty:exit', payload)
      }
    })
  }
}

export async function reestablishRelayStack(
  targetId: string,
  getMainWindow: () => BrowserWindow | null,
  connectionManager: SshConnectionManager | null,
  activeMultiplexers: Map<string, SshChannelMultiplexer>
): Promise<void> {
  const conn = connectionManager?.getConnection(targetId)
  if (!conn) {
    return
  }

  // Dispose old multiplexer with connection_lost reason
  const oldMux = activeMultiplexers.get(targetId)
  if (oldMux && !oldMux.isDisposed()) {
    oldMux.dispose('connection_lost')
  }
  activeMultiplexers.delete(targetId)
  unregisterSshPtyProvider(targetId)
  unregisterSshFilesystemProvider(targetId)
  unregisterSshGitProvider(targetId)

  try {
    const { transport } = await deployAndLaunchRelay(conn)
    const mux = new SshChannelMultiplexer(transport)
    activeMultiplexers.set(targetId, mux)

    const ptyProvider = new SshPtyProvider(targetId, mux)
    registerSshPtyProvider(targetId, ptyProvider)

    const fsProvider = new SshFilesystemProvider(targetId, mux)
    registerSshFilesystemProvider(targetId, fsProvider)

    const gitProvider = new SshGitProvider(targetId, mux)
    registerSshGitProvider(targetId, gitProvider)

    wireUpSshPtyEvents(ptyProvider, getMainWindow)

    // Re-attach to any PTYs that were alive before the disconnect.
    // The relay keeps them running during its grace period.
    const ptyIds = getPtyIdsForConnection(targetId)
    for (const ptyId of ptyIds) {
      try {
        await ptyProvider.attach(ptyId)
      } catch {
        // PTY may have exited during the disconnect — ignore
      }
    }
  } catch (err) {
    console.warn(
      `[ssh] Failed to re-establish relay for ${targetId}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
