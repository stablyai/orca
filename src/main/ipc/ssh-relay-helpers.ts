// Why: extracted from ssh.ts to keep the main IPC module under the max-lines
// threshold. These helpers manage relay lifecycle (cleanup, event wiring,
// reconnection) and are called from both initial connect and reconnection paths.

import type { BrowserWindow } from 'electron'
import { deployAndLaunchRelay } from '../ssh/ssh-relay-deploy'
import { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { SshPtyProvider } from '../providers/ssh-pty-provider'
import { SshFilesystemProvider } from '../providers/ssh-filesystem-provider'
import { SshGitProvider } from '../providers/ssh-git-provider'
import {
  registerSshPtyProvider,
  unregisterSshPtyProvider,
  getSshPtyProvider,
  getPtyIdsForConnection,
  clearPtyOwnershipForConnection,
  clearProviderPtyState,
  deletePtyOwnership
} from './pty'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider,
  getSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import type { SshPortForwardManager } from '../ssh/ssh-port-forward'
import type { SshConnectionManager } from '../ssh/ssh-connection'
import type { Store } from '../persistence'

// Why: the relay's RelayContext starts with rootsRegistered=false and rejects
// all FS operations until at least one root is registered via
// session.registerRoot. This must be called after every relay deploy — both
// initial connect and reconnection — because each deploy creates a fresh
// RelayContext on the remote host.
export function registerRelayRoots(
  mux: SshChannelMultiplexer,
  connectionId: string,
  store: Store
): void {
  for (const repo of store.getRepos()) {
    if (repo.connectionId === connectionId) {
      mux.notify('session.registerRoot', { rootPath: repo.path })
    }
  }
}

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
  // Why: clear PTY ownership entries before unregistering the provider so
  // stale ownership entries don't route future lookups to a dead provider.
  clearPtyOwnershipForConnection(targetId)

  // Why: dispose notification subscriptions before unregistering so the
  // multiplexer's handler list doesn't retain stale callbacks that fire
  // into a torn-down provider after disconnect.
  const ptyProvider = getSshPtyProvider(targetId)
  if (ptyProvider && 'dispose' in ptyProvider) {
    ;(ptyProvider as { dispose: () => void }).dispose()
  }
  const fsProvider = getSshFilesystemProvider(targetId)
  if (fsProvider && 'dispose' in fsProvider) {
    ;(fsProvider as { dispose: () => void }).dispose()
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
  // Why: resolving the window lazily on each event (instead of capturing once)
  // ensures events reach the current window even if macOS app re-activation
  // creates a new BrowserWindow after the initial wiring.
  ptyProvider.onData((payload) => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:data', payload)
    }
  })
  ptyProvider.onExit((payload) => {
    clearProviderPtyState(payload.id)
    // Why: without this, the ownership entry for the exited remote PTY lingers,
    // routing future lookups to the SSH provider for a PTY that no longer exists.
    deletePtyOwnership(payload.id)
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:exit', payload)
    }
  })
}

// Why: overlapping reconnection attempts (e.g. SSH connection flaps twice
// quickly) would cause two concurrent reestablishRelayStack calls, leaking
// relay processes and multiplexers from the first call. This map lets us
// cancel the stale attempt before starting a new one.
const reestablishAbortControllers = new Map<string, AbortController>()

export async function reestablishRelayStack(
  targetId: string,
  getMainWindow: () => BrowserWindow | null,
  connectionManager: SshConnectionManager | null,
  activeMultiplexers: Map<string, SshChannelMultiplexer>,
  portForwardManager?: SshPortForwardManager | null,
  store?: Store | null
): Promise<void> {
  const conn = connectionManager?.getConnection(targetId)
  if (!conn) {
    return
  }

  // Why: port forwards hold open local TCP servers backed by SSH channels that
  // are now dead. Without cleanup, clients connecting to forwarded ports hang.
  portForwardManager?.removeAllForwards(targetId)

  const prevAbort = reestablishAbortControllers.get(targetId)
  if (prevAbort) {
    prevAbort.abort()
  }
  const abortController = new AbortController()
  reestablishAbortControllers.set(targetId, abortController)

  // Dispose old multiplexer with connection_lost reason
  const oldMux = activeMultiplexers.get(targetId)
  if (oldMux && !oldMux.isDisposed()) {
    oldMux.dispose('connection_lost')
  }
  activeMultiplexers.delete(targetId)

  // Why: dispose notification subscriptions before unregistering so stale
  // callbacks from the old multiplexer don't fire into a torn-down provider.
  const oldPtyProvider = getSshPtyProvider(targetId)
  if (oldPtyProvider && 'dispose' in oldPtyProvider) {
    ;(oldPtyProvider as { dispose: () => void }).dispose()
  }
  const oldFsProvider = getSshFilesystemProvider(targetId)
  if (oldFsProvider && 'dispose' in oldFsProvider) {
    ;(oldFsProvider as { dispose: () => void }).dispose()
  }

  unregisterSshPtyProvider(targetId)
  unregisterSshFilesystemProvider(targetId)
  unregisterSshGitProvider(targetId)

  try {
    const { transport } = await deployAndLaunchRelay(conn)

    if (abortController.signal.aborted) {
      // Why: the relay is already running on the remote. Creating a temporary
      // multiplexer and immediately disposing it sends a clean shutdown to the
      // relay process. Without this, the orphaned relay runs until its grace
      // timer expires.
      const orphanMux = new SshChannelMultiplexer(transport)
      orphanMux.dispose()
      return
    }

    const mux = new SshChannelMultiplexer(transport)
    activeMultiplexers.set(targetId, mux)

    if (store) {
      registerRelayRoots(mux, targetId, store)
    }

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
  } finally {
    if (reestablishAbortControllers.get(targetId) === abortController) {
      reestablishAbortControllers.delete(targetId)
    }
  }
}
