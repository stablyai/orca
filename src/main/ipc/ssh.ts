import { ipcMain, type BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { SshConnectionStore } from '../ssh/ssh-connection-store'
import { SshConnectionManager, type SshConnectionCallbacks } from '../ssh/ssh-connection'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { SshRelaySession } from '../ssh/ssh-relay-session'
import { SshPortForwardManager } from '../ssh/ssh-port-forward'
import type { SshTarget, SshConnectionState, SshConnectionStatus } from '../../shared/ssh-types'
import { isAuthError } from '../ssh/ssh-connection-utils'
import { registerSshBrowseHandler } from './ssh-browse'
import { requestCredential, registerCredentialHandler } from './ssh-passphrase'

let sshStore: SshConnectionStore | null = null
let connectionManager: SshConnectionManager | null = null
let portForwardManager: SshPortForwardManager | null = null

// Why: one session per SSH target encapsulates the entire relay lifecycle
// (multiplexer, providers, abort controller, state machine). Eliminates the
// scattered Maps/Sets that previously tracked this state independently.
const activeSessions = new Map<string, SshRelaySession>()

// Why: ssh:testConnection calls connect() then disconnect(), which fires
// state-change events to the renderer. This causes worktree cards to briefly
// flash "connected" then "disconnected". Suppressing broadcasts during tests
// avoids that visual glitch.
const testingTargets = new Set<string>()

export function registerSshHandlers(
  store: Store,
  getMainWindow: () => BrowserWindow | null
): { connectionManager: SshConnectionManager; sshStore: SshConnectionStore } {
  // Why: on macOS, app re-activation creates a new BrowserWindow and re-calls
  // this function. ipcMain.handle() throws if a handler is already registered,
  // so we must remove any prior handlers before re-registering.
  for (const ch of [
    'ssh:listTargets',
    'ssh:addTarget',
    'ssh:updateTarget',
    'ssh:removeTarget',
    'ssh:importConfig',
    'ssh:connect',
    'ssh:disconnect',
    'ssh:getState',
    'ssh:testConnection',
    'ssh:addPortForward',
    'ssh:removePortForward',
    'ssh:listPortForwards'
  ]) {
    ipcMain.removeHandler(ch)
  }

  sshStore = new SshConnectionStore(store)

  registerCredentialHandler(getMainWindow)

  // Why: tracks whether a credential prompt was triggered during the current
  // ssh:connect call. Used to set lastRequiredPassphrase on the target so
  // startup reconnect can defer passphrase-protected targets to tab focus.
  const credentialRequestedForTarget = new Set<string>()

  const callbacks: SshConnectionCallbacks = {
    onCredentialRequest: (targetId, kind, detail) => {
      credentialRequestedForTarget.add(targetId)
      return requestCredential(getMainWindow, targetId, kind, detail)
    },
    onStateChange: (targetId: string, state: SshConnectionState) => {
      if (testingTargets.has(targetId)) {
        return
      }

      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('ssh:state-changed', { targetId, state })
      }

      // Why: when SSH reconnects after a network blip, we must re-deploy the
      // relay and rebuild the full provider stack. The session's state machine
      // ensures this only triggers when appropriate — 'deploying' state from
      // an explicit ssh:connect is not 'ready', so this branch won't fire.
      const session = activeSessions.get(targetId)
      if (
        state.status === 'connected' &&
        state.reconnectAttempt === 0 &&
        session?.getState() === 'ready'
      ) {
        const target = sshStore?.getTarget(targetId)
        const conn = connectionManager?.getConnection(targetId)
        if (conn) {
          void session.reconnect(conn, target?.relayGracePeriodSeconds)
        }
      }
    }
  }

  connectionManager = new SshConnectionManager(callbacks)
  portForwardManager = new SshPortForwardManager()
  registerSshBrowseHandler(() => connectionManager)

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

    let conn
    // Why: create the session early so onStateChange sees it in 'deploying'
    // state and knows not to trigger reconnect logic.
    const session = new SshRelaySession(args.targetId, getMainWindow, store, portForwardManager!)
    activeSessions.set(args.targetId, session)

    try {
      conn = await connectionManager!.connect(target)
    } catch (err) {
      // Why: SshConnection.connect() sets its internal state, but the
      // onStateChange callback may not have propagated to the renderer.
      // Explicitly broadcast so the UI leaves 'connecting'.
      const errObj = err instanceof Error ? err : new Error(String(err))
      const status: SshConnectionStatus = isAuthError(errObj) ? 'auth-failed' : 'error'
      // Why: if a credential prompt was shown before the failure, the target
      // would stay in credentialRequestedForTarget. A later successful connect
      // that doesn't prompt would then incorrectly persist lastRequiredPassphrase
      // = true, causing startup to defer this target even though it no longer
      // needs a passphrase.
      credentialRequestedForTarget.delete(args.targetId)
      activeSessions.delete(args.targetId)
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('ssh:state-changed', {
          targetId: args.targetId,
          state: {
            targetId: args.targetId,
            status,
            error: errObj.message,
            reconnectAttempt: 0
          }
        })
      }
      throw err
    }

    try {
      // Deploy relay and establish multiplexer
      callbacks.onStateChange(args.targetId, {
        targetId: args.targetId,
        status: 'deploying-relay',
        error: null,
        reconnectAttempt: 0
      })

      await session.establish(conn, target.relayGracePeriodSeconds)

      // Why: we manually pushed `deploying-relay` above, so the renderer's
      // state is stuck there. Send `connected` directly to the renderer
      // instead of going through callbacks.onStateChange, which would
      // trigger the reconnection logic.
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
      activeSessions.delete(args.targetId)
      await connectionManager!.disconnect(args.targetId)
      throw err
    }

    // Why: persist whether this connection required a credential prompt so
    // startup reconnect can partition targets into eager vs deferred without
    // re-probing keys. Updated on every successful connect so the flag stays
    // current as users add/remove passphrases from their keys.
    const requiredPassphrase = credentialRequestedForTarget.has(args.targetId)
    credentialRequestedForTarget.delete(args.targetId)
    sshStore!.updateTarget(args.targetId, { lastRequiredPassphrase: requiredPassphrase })

    return connectionManager!.getState(args.targetId)
  })

  ipcMain.handle('ssh:disconnect', async (_event, args: { targetId: string }) => {
    const session = activeSessions.get(args.targetId)
    if (session) {
      session.dispose()
      activeSessions.delete(args.targetId)
    }
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

    // Why: testConnection calls connect() then disconnect(). If the target
    // already has an active relay session, connect() would reuse the connection
    // but disconnect() would tear down the entire relay stack — killing all
    // active PTYs and file watchers for a "test" that was supposed to be safe.
    const existingSession = activeSessions.get(args.targetId)
    if (existingSession?.getState() === 'ready') {
      return { success: true, state: connectionManager!.getState(args.targetId) }
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
  return activeSessions.get(connectionId)?.getMux() ?? undefined
}
