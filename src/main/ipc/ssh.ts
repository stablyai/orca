import { randomUUID } from 'crypto'
import { ipcMain, type BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { SshConnectionStore } from '../ssh/ssh-connection-store'
import { SshConnectionManager, type SshConnectionCallbacks } from '../ssh/ssh-connection'
import { deployAndLaunchRelay } from '../ssh/ssh-relay-deploy'
import { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { SshPtyProvider } from '../providers/ssh-pty-provider'
import { SshFilesystemProvider } from '../providers/ssh-filesystem-provider'
import { SshGitProvider } from '../providers/ssh-git-provider'
import { registerSshPtyProvider } from './pty'
import { registerSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { registerSshGitProvider } from '../providers/ssh-git-dispatch'
import { SshPortForwardManager } from '../ssh/ssh-port-forward'
import type { SshTarget, SshConnectionState } from '../../shared/ssh-types'
import { cleanupConnection, wireUpSshPtyEvents, reestablishRelayStack } from './ssh-relay-helpers'

let sshStore: SshConnectionStore | null = null
let connectionManager: SshConnectionManager | null = null
let portForwardManager: SshPortForwardManager | null = null

// Track multiplexers and providers per connection for cleanup
const activeMultiplexers = new Map<string, SshChannelMultiplexer>()

// Why: tracks which connections have completed initial relay setup, so
// onStateChange can distinguish "reconnected after drop" from "first connect".
const initializedConnections = new Set<string>()

// Why: ssh:testConnection calls connect() then disconnect(), which fires
// state-change events to the renderer. This causes worktree cards to briefly
// flash "connected" then "disconnected". Suppressing broadcasts during tests
// avoids that visual glitch.
const testingTargets = new Set<string>()

export function registerSshHandlers(
  store: Store,
  getMainWindow: () => BrowserWindow | null
): { connectionManager: SshConnectionManager; sshStore: SshConnectionStore } {
  sshStore = new SshConnectionStore(store)

  const callbacks: SshConnectionCallbacks = {
    onStateChange: (targetId: string, state: SshConnectionState) => {
      if (testingTargets.has(targetId)) {
        return
      }

      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('ssh:state-changed', { targetId, state })
      }

      // Why: when SSH reconnects after a network blip, we must re-deploy the
      // relay and rebuild the full provider stack. The old multiplexer's pending
      // requests are already rejected with CONNECTION_LOST by dispose().
      if (
        state.status === 'connected' &&
        state.reconnectAttempt === 0 &&
        initializedConnections.has(targetId)
      ) {
        void reestablishRelayStack(targetId, getMainWindow, connectionManager, activeMultiplexers)
      }
    },

    onHostKeyVerify: async (req) => {
      const win = getMainWindow()
      if (!win || win.isDestroyed()) {
        return false
      }

      return new Promise<boolean>((resolve) => {
        const channel = `ssh:host-key-verify-response-${randomUUID()}`
        win.webContents.send('ssh:host-key-verify', { ...req, responseChannel: channel })
        ipcMain.once(channel, (_event, accepted: boolean) => {
          resolve(accepted)
        })
      })
    },

    onAuthChallenge: async (req) => {
      const win = getMainWindow()
      if (!win || win.isDestroyed()) {
        return []
      }

      return new Promise<string[]>((resolve) => {
        const channel = `ssh:auth-challenge-response-${randomUUID()}`
        win.webContents.send('ssh:auth-challenge', { ...req, responseChannel: channel })
        ipcMain.once(channel, (_event, responses: string[]) => {
          resolve(responses)
        })
      })
    },

    onPasswordPrompt: async (targetId: string) => {
      const win = getMainWindow()
      if (!win || win.isDestroyed()) {
        return null
      }

      return new Promise<string | null>((resolve) => {
        const channel = `ssh:password-response-${randomUUID()}`
        win.webContents.send('ssh:password-prompt', { targetId, responseChannel: channel })
        ipcMain.once(channel, (_event, password: string | null) => {
          resolve(password)
        })
      })
    }
  }

  connectionManager = new SshConnectionManager(callbacks)
  portForwardManager = new SshPortForwardManager()

  // ── Target CRUD ────────────────────────────────────────────────────

  ipcMain.handle('ssh:listTargets', () => {
    return sshStore!.listTargets()
  })

  ipcMain.handle('ssh:addTarget', (_event, args: { target: Omit<SshTarget, 'id'> }) => {
    return sshStore!.addTarget(args.target)
  })

  ipcMain.handle(
    'ssh:updateTarget',
    (_event, args: { id: string; updates: Partial<Omit<SshTarget, 'id'>> }) => {
      return sshStore!.updateTarget(args.id, args.updates)
    }
  )

  ipcMain.handle('ssh:removeTarget', (_event, args: { id: string }) => {
    sshStore!.removeTarget(args.id)
  })

  ipcMain.handle('ssh:importConfig', () => {
    return sshStore!.importFromSshConfig()
  })

  // ── Connection lifecycle ───────────────────────────────────────────

  ipcMain.handle('ssh:connect', async (_event, args: { targetId: string }) => {
    const target = sshStore!.getTarget(args.targetId)
    if (!target) {
      throw new Error(`SSH target "${args.targetId}" not found`)
    }

    const conn = await connectionManager!.connect(target)

    // Deploy relay and establish multiplexer
    callbacks.onStateChange(args.targetId, {
      targetId: args.targetId,
      status: 'deploying-relay',
      error: null,
      reconnectAttempt: 0
    })

    try {
      const { transport } = await deployAndLaunchRelay(conn, (status) => {
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('ssh:deploy-progress', { targetId: args.targetId, status })
        }
      })

      const mux = new SshChannelMultiplexer(transport)
      activeMultiplexers.set(args.targetId, mux)

      const ptyProvider = new SshPtyProvider(args.targetId, mux)
      registerSshPtyProvider(args.targetId, ptyProvider)

      const fsProvider = new SshFilesystemProvider(args.targetId, mux)
      registerSshFilesystemProvider(args.targetId, fsProvider)

      const gitProvider = new SshGitProvider(args.targetId, mux)
      registerSshGitProvider(args.targetId, gitProvider)

      wireUpSshPtyEvents(ptyProvider, getMainWindow)
      initializedConnections.add(args.targetId)

      // Why: we manually pushed `deploying-relay` above, so the renderer's
      // state is stuck there. Send `connected` directly to the renderer
      // instead of going through callbacks.onStateChange, which would
      // trigger the reconnection logic (reestablishRelayStack).
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('ssh:state-changed', {
          targetId: args.targetId,
          state: {
            targetId: args.targetId,
            status: 'connected',
            error: null,
            reconnectAttempt: 0
          }
        })
      }
    } catch (err) {
      // Relay deployment failed — disconnect SSH
      await connectionManager!.disconnect(args.targetId)
      throw err
    }

    return connectionManager!.getState(args.targetId)
  })

  ipcMain.handle('ssh:disconnect', async (_event, args: { targetId: string }) => {
    cleanupConnection(args.targetId, activeMultiplexers, initializedConnections, portForwardManager)
    await connectionManager!.disconnect(args.targetId)
  })

  ipcMain.handle('ssh:getState', (_event, args: { targetId: string }) => {
    return connectionManager!.getState(args.targetId)
  })

  ipcMain.handle('ssh:testConnection', async (_event, args: { targetId: string }) => {
    const target = sshStore!.getTarget(args.targetId)
    if (!target) {
      throw new Error(`SSH target "${args.targetId}" not found`)
    }

    testingTargets.add(args.targetId)
    try {
      const conn = await connectionManager!.connect(target)
      const state = conn.getState()
      await connectionManager!.disconnect(args.targetId)
      return { success: true, state }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err)
      }
    } finally {
      testingTargets.delete(args.targetId)
    }
  })

  // ── Port forwarding ─────────────────────────────────────────────────

  ipcMain.handle(
    'ssh:addPortForward',
    async (
      _event,
      args: {
        targetId: string
        localPort: number
        remoteHost: string
        remotePort: number
        label?: string
      }
    ) => {
      const conn = connectionManager!.getConnection(args.targetId)
      if (!conn) {
        throw new Error(`SSH connection "${args.targetId}" not found`)
      }
      return portForwardManager!.addForward(
        args.targetId,
        conn,
        args.localPort,
        args.remoteHost,
        args.remotePort,
        args.label
      )
    }
  )

  ipcMain.handle('ssh:removePortForward', (_event, args: { id: string }) => {
    return portForwardManager!.removeForward(args.id)
  })

  ipcMain.handle('ssh:listPortForwards', (_event, args?: { targetId?: string }) => {
    return portForwardManager!.listForwards(args?.targetId)
  })

  return { connectionManager, sshStore }
}

export function getSshConnectionManager(): SshConnectionManager | null {
  return connectionManager
}

export function getSshConnectionStore(): SshConnectionStore | null {
  return sshStore
}

export function getActiveMultiplexer(connectionId: string): SshChannelMultiplexer | undefined {
  return activeMultiplexers.get(connectionId)
}
