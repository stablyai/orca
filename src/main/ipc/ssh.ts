/* oxlint-disable max-lines -- Why: co-locates SSH IPC handlers, port-forward
broadcasting, and session lifecycle in one file to keep the data flow obvious. */
import { ipcMain, type BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { SshConnectionStore } from '../ssh/ssh-connection-store'
import { SshConnectionManager, type SshConnectionCallbacks } from '../ssh/ssh-connection'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { SshRelaySession } from '../ssh/ssh-relay-session'
import { SshPortForwardManager } from '../ssh/ssh-port-forward'
import type {
  SshTarget,
  SshConnectionState,
  SshConnectionStatus,
  DetectedPort,
  SavedPortForward
} from '../../shared/ssh-types'
import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../shared/constants'
import { isAuthError } from '../ssh/ssh-connection-utils'
import { isSshPtyNotFoundError } from '../providers/ssh-pty-provider'
import { registerSshBrowseHandler } from './ssh-browse'
import { requestCredential, registerCredentialHandler } from './ssh-passphrase'
import {
  clearProviderPtyState,
  deletePtyOwnership,
  getPtyIdsForConnection,
  getSshPtyProvider
} from './pty'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

let sshStore: SshConnectionStore | null = null
let connectionManager: SshConnectionManager | null = null
let portForwardManager: SshPortForwardManager | null = null

// Why: one session per SSH target encapsulates the entire relay lifecycle
// (multiplexer, providers, abort controller, state machine). Eliminates the
// scattered Maps/Sets that previously tracked this state independently.
const activeSessions = new Map<string, SshRelaySession>()

function relayGracePeriodForTarget(target: SshTarget | null | undefined): number | undefined {
  if (!target?.remoteWorkspaceSyncEnabled) {
    return target?.relayGracePeriodSeconds
  }
  // Why: cross-device sync should survive transient app closes, but an
  // unset value must not mean "keep remote PTYs forever" after disconnect.
  return target.remoteWorkspaceSyncGracePeriodSeconds ?? 300
}

// Why: multiple renderer tabs for the same SSH target can fire ssh:connect
// concurrently. Without serialization, the second call interleaves with the
// first — both see no existing session, both create one, and the first one
// leaks. This map holds the in-flight connect promise so the second call
// awaits the first rather than racing.
const connectInFlight = new Map<string, Promise<SshConnectionState>>()

// Why: ssh:testConnection calls connect() then disconnect(), which fires
// state-change events to the renderer. This causes worktree cards to briefly
// flash "connected" then "disconnected". Suppressing broadcasts during tests
// avoids that visual glitch.
const testingTargets = new Set<string>()

// Why: when a relay channel keeps dying (e.g. a stale --connect bridge keeps
// being replaced, a remote-side bug closes the channel right after handshake,
// or a mismatched relay binary refuses every handshake), the unguarded
// _onRelayLost handler reconnects as fast as the network allows, hammering
// both the local main process and the remote sshd in a tight loop. Track
// per-target reconnect attempts and apply exponential backoff so the loop
// terminates with a recoverable error instead of running forever. Successful
// `ready` resets the attempt counter for the next genuine drop.
type RelayLostBackoffState = {
  attempts: number
  lastAttemptStartedAt: number
  pendingTimer: ReturnType<typeof setTimeout> | null
}
const relayLostBackoff = new Map<string, RelayLostBackoffState>()
const RELAY_LOST_MAX_ATTEMPTS = 6
const RELAY_LOST_BASE_DELAY_MS = 500
const RELAY_LOST_MAX_DELAY_MS = 15_000
// Why: if a fresh reconnect's mux dies within this window, the new session
// never stabilized (a flap, not a real recovery). Without this clamp the
// attempt counter would be reset prematurely by a mux that "reached ready"
// only on paper. 5 seconds covers normal post-deploy provider registration
// and PTY reattach without being so generous that a real long-lived session
// looks like a flap.
const RELAY_LOST_STABILIZED_MS = 5_000

function clearRelayLostBackoff(targetId: string): void {
  const state = relayLostBackoff.get(targetId)
  if (state?.pendingTimer) {
    clearTimeout(state.pendingTimer)
  }
  relayLostBackoff.delete(targetId)
}

function broadcastPortForwards(getMainWindow: () => BrowserWindow | null, targetId: string): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    return
  }
  const forwards = portForwardManager!.listForwards(targetId)
  win.webContents.send('ssh:port-forwards-changed', { targetId, forwards })
}

function broadcastDetectedPorts(
  getMainWindow: () => BrowserWindow | null,
  targetId: string,
  ports: DetectedPort[]
): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    return
  }
  win.webContents.send('ssh:detected-ports-changed', { targetId, ports })
}

// Why: after user-initiated add/remove/update the runtime manager is the
// single source of truth — write exactly its entries and nothing else.
// A separate helper (persistPortForwardsWithUnrestored) preserves entries
// that failed to restore so they retry on next reconnect.
function persistPortForwards(targetId: string): void {
  const active = portForwardManager!.listForwards(targetId)
  const saved: SavedPortForward[] = active.map((f) => ({
    localPort: f.localPort,
    remoteHost: f.remoteHost,
    remotePort: f.remotePort,
    label: f.label
  }))
  sshStore!.updateTarget(targetId, { portForwards: saved.length > 0 ? saved : undefined })
}

// Why: called after restorePortForwards so that forwards which failed to
// restore (e.g. port temporarily busy) are kept in the persisted list and
// retried on next reconnect, rather than being silently dropped.
function persistPortForwardsWithUnrestored(targetId: string): void {
  const active = portForwardManager!.listForwards(targetId)
  const activeKeys = new Set(active.map((f) => `${f.localPort}:${f.remoteHost}:${f.remotePort}`))

  const existing = sshStore!.getTarget(targetId)?.portForwards ?? []
  const unrestored = existing.filter(
    (pf) => !activeKeys.has(`${pf.localPort}:${pf.remoteHost}:${pf.remotePort}`)
  )

  const saved: SavedPortForward[] = [
    ...active.map((f) => ({
      localPort: f.localPort,
      remoteHost: f.remoteHost,
      remotePort: f.remotePort,
      label: f.label
    })),
    ...unrestored
  ]
  sshStore!.updateTarget(targetId, { portForwards: saved.length > 0 ? saved : undefined })
}

async function restorePortForwards(
  targetId: string,
  getMainWindow: () => BrowserWindow | null
): Promise<void> {
  const target = sshStore!.getTarget(targetId)
  if (!target?.portForwards?.length) {
    return
  }
  const conn = connectionManager!.getConnection(targetId)
  if (!conn) {
    return
  }

  // Why: don't prune failed restores from persisted state. A failure may
  // be transient (e.g. port temporarily busy at startup) and the forward
  // should be retried on the next reconnect rather than silently deleted.
  for (const saved of target.portForwards) {
    // Why: if the session disconnects/reconnects while this loop is running,
    // a new connection object is created. Checking identity avoids adding
    // forwards against a stale connection, which would leak local listeners
    // that the next reconnect's removeAllForwards() doesn't know about.
    if (connectionManager!.getConnection(targetId) !== conn) {
      return
    }
    try {
      await portForwardManager!.addForward(
        targetId,
        conn,
        saved.localPort,
        saved.remoteHost,
        saved.remotePort,
        saved.label
      )
    } catch (err) {
      console.warn(
        `[ssh] Failed to restore forward :${saved.localPort} → ${saved.remoteHost}:${saved.remotePort}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  persistPortForwardsWithUnrestored(targetId)
  broadcastPortForwards(getMainWindow, targetId)
}

export function registerSshHandlers(
  store: Store,
  getMainWindow: () => BrowserWindow | null,
  runtime?: OrcaRuntimeService
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
    'ssh:terminateSessions',
    'ssh:getState',
    'ssh:needsPassphrasePrompt',
    'ssh:testConnection',
    'ssh:addPortForward',
    'ssh:updatePortForward',
    'ssh:removePortForward',
    'ssh:listPortForwards',
    'ssh:listDetectedPorts'
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
      if (!session) {
        return
      }
      // Why: allow reconnect from both 'ready' (normal network blip) and
      // 'reconnecting' (previous reconnect attempt failed, e.g. relay deploy
      // error on a working SSH connection). Without the 'reconnecting' check,
      // a failed relay deploy would permanently brick the session.
      const sessionState = session.getState()
      if (
        state.status === 'connected' &&
        state.reconnectAttempt === 0 &&
        (sessionState === 'ready' || sessionState === 'reconnecting')
      ) {
        const target = sshStore?.getTarget(targetId)
        const conn = connectionManager?.getConnection(targetId)
        if (conn) {
          void session.reconnect(conn, relayGracePeriodForTarget(target))
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

  ipcMain.handle('ssh:removeTarget', async (_event, args: { id: string }) => {
    const session = activeSessions.get(args.id)
    if (session) {
      // Why: removing a target is destructive. Tear down the live relay before
      // deleting metadata so callbacks cannot keep using an orphan target id.
      await portForwardManager!.removeAllForwards(args.id)
      session.dispose()
      activeSessions.delete(args.id)
      clearRelayLostBackoff(args.id)
    }
    try {
      await connectionManager!.disconnect(args.id)
    } catch (err) {
      console.warn(
        `[ssh] Failed to disconnect removed target ${args.id}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    store.removeSshRemotePtyLeases(args.id)
    sshStore!.removeTarget(args.id)
  })

  ipcMain.handle('ssh:importConfig', () => {
    return sshStore!.importFromSshConfig()
  })

  // ── Connection lifecycle ───────────────────────────────────────────

  ipcMain.handle('ssh:connect', async (_event, args: { targetId: string }) => {
    // Why: serialize concurrent ssh:connect calls for the same target.
    // Multiple tabs can fire connect simultaneously; without this, they
    // interleave and the first session leaks.
    const existing = connectInFlight.get(args.targetId)
    if (existing) {
      return existing
    }

    const promise = doConnect(args.targetId)
    connectInFlight.set(args.targetId, promise)
    try {
      return await promise
    } finally {
      connectInFlight.delete(args.targetId)
    }
  })

  async function doConnect(targetId: string): Promise<SshConnectionState> {
    const target = sshStore!.getTarget(targetId)
    if (!target) {
      throw new Error(`SSH target "${targetId}" not found`)
    }

    let conn
    // Why: dispose any existing session to avoid leaking the old multiplexer,
    // providers, and timers. This handles double-connect (user clicks connect
    // while already connected) and reconnect-after-error.
    const existingSession = activeSessions.get(targetId)
    if (existingSession) {
      // Why: await port teardown before disposing so the OS fully releases
      // local ports. Without this, restorePortForwards in the new session
      // can hit EADDRINUSE on the same ports the old session was using.
      await portForwardManager!.removeAllForwards(targetId)
      existingSession.detach()
      activeSessions.delete(targetId)
      clearRelayLostBackoff(targetId)
    }

    // Why: create the session early so onStateChange sees it in 'deploying'
    // state and knows not to trigger reconnect logic.
    const session = new SshRelaySession(
      targetId,
      getMainWindow,
      store,
      portForwardManager!,
      runtime,
      (tid, ports, _platform) => {
        broadcastDetectedPorts(getMainWindow, tid, ports)
      }
    )
    activeSessions.set(targetId, session)

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
      credentialRequestedForTarget.delete(targetId)
      activeSessions.delete(targetId)
      clearRelayLostBackoff(targetId)
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('ssh:state-changed', {
          targetId,
          state: {
            targetId,
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
      callbacks.onStateChange(targetId, {
        targetId,
        status: 'deploying-relay',
        error: null,
        reconnectAttempt: 0
      })

      // Why: the relay exec channel can close independently of the SSH
      // connection (e.g. --connect bridge exits, relay process crashes).
      // When that happens, the mux is disposed but onStateChange never
      // fires because the SSH connection is still alive. This callback
      // triggers session.reconnect() using the live SSH connection.
      // Set before establish() so the callback is in place if the relay
      // dies during the deploy/connect sequence.
      // Why: a wire-handshake mismatch (typed RelayVersionMismatchError) means
      // the local client and remote daemon are at different code versions —
      // no amount of backoff will reconcile them. Skip the relay-lost loop
      // entirely and surface a terminal "please reconnect manually" error.
      session.setOnTerminalRelayError((tid, err) => {
        clearRelayLostBackoff(tid)
        console.warn(
          `[ssh] Terminal relay error for ${tid}: ${err.message}; skipping reconnect backoff.`
        )
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('ssh:state-changed', {
            targetId: tid,
            state: {
              targetId: tid,
              status: 'error',
              error: err.message,
              reconnectAttempt: 0
            }
          })
        }
      })

      session.setOnRelayLost((tid) => {
        const s = activeSessions.get(tid)
        if (!s) {
          return
        }
        const c = connectionManager?.getConnection(tid)
        if (!c) {
          return
        }
        const t = sshStore?.getTarget(tid)

        // Why: bounded exponential backoff. Without this, a remote-side bug
        // that closes every fresh --connect channel turns into an infinite
        // tight loop spawning relay deploys until the user force-quits.
        const state = relayLostBackoff.get(tid) ?? {
          attempts: 0,
          lastAttemptStartedAt: 0,
          pendingTimer: null
        }
        if (state.pendingTimer) {
          // A retry is already scheduled — coalesce this burst.
          return
        }
        if (state.attempts >= RELAY_LOST_MAX_ATTEMPTS) {
          console.warn(
            `[ssh] Relay channel for ${tid} kept dying across ${state.attempts} attempts; giving up. User must reconnect manually.`
          )
          relayLostBackoff.delete(tid)
          // Why: surface the failure so the renderer can prompt the user.
          // A still-live SSH connection with a dead relay is otherwise an
          // invisible failure — typing in remote terminals just stops working.
          const win = getMainWindow()
          if (win && !win.isDestroyed()) {
            win.webContents.send('ssh:state-changed', {
              targetId: tid,
              state: {
                targetId: tid,
                status: 'error',
                error: 'Relay channel kept dropping. Please reconnect.',
                reconnectAttempt: 0
              }
            })
          }
          return
        }
        const delay = Math.min(
          RELAY_LOST_BASE_DELAY_MS * 2 ** state.attempts,
          RELAY_LOST_MAX_DELAY_MS
        )
        state.attempts += 1
        state.pendingTimer = setTimeout(() => {
          state.pendingTimer = null
          state.lastAttemptStartedAt = Date.now()
          relayLostBackoff.set(tid, state)
          const liveConn = connectionManager?.getConnection(tid)
          if (!liveConn || !activeSessions.has(tid)) {
            return
          }
          void s.reconnect(liveConn, relayGracePeriodForTarget(t))
        }, delay)
        relayLostBackoff.set(tid, state)
        console.warn(
          `[ssh] Relay channel for ${tid} lost; reconnect attempt ${state.attempts}/${RELAY_LOST_MAX_ATTEMPTS} in ${delay}ms`
        )
      })

      // Why: fires after both establish() and reconnect() reach 'ready'.
      // Re-creates persisted port forwards so they survive app restarts
      // and network blips without manual re-configuration. We also clear
      // the relay-lost backoff state so a subsequent genuine drop starts
      // from a fresh attempt counter — but only if the session had a chance
      // to stabilize, otherwise rapid `ready → lost → ready → lost` flaps
      // would silently keep retrying forever.
      session.setOnReady((tid) => {
        const state = relayLostBackoff.get(tid)
        if (state) {
          const stabilized =
            state.lastAttemptStartedAt === 0 ||
            Date.now() - state.lastAttemptStartedAt >= RELAY_LOST_STABILIZED_MS
          if (stabilized) {
            relayLostBackoff.delete(tid)
          }
        }
        void restorePortForwards(tid, getMainWindow)
      })

      await session.establish(conn, relayGracePeriodForTarget(target))

      // Why: we manually pushed `deploying-relay` above, so the renderer's
      // state is stuck there. Send `connected` directly to the renderer
      // instead of going through callbacks.onStateChange, which would
      // trigger the reconnection logic.
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('ssh:state-changed', {
          targetId,
          state: {
            targetId,
            status: 'connected',
            error: null,
            reconnectAttempt: 0
          }
        })
      }
    } catch (err) {
      // Relay deployment failed — disconnect SSH
      activeSessions.delete(targetId)
      clearRelayLostBackoff(targetId)
      await connectionManager!.disconnect(targetId)
      throw err
    }

    // Why: persist whether this connection required a credential prompt so
    // startup reconnect can partition targets into eager vs deferred without
    // re-probing keys. Updated on every successful connect so the flag stays
    // current as users add/remove passphrases from their keys.
    const requiredPassphrase = credentialRequestedForTarget.has(targetId)
    credentialRequestedForTarget.delete(targetId)
    sshStore!.updateTarget(targetId, { lastRequiredPassphrase: requiredPassphrase })

    return connectionManager!.getState(targetId)!
  }

  ipcMain.handle('ssh:disconnect', async (_event, args: { targetId: string }) => {
    const session = activeSessions.get(args.targetId)
    if (session) {
      // Why: await port teardown so local listeners are fully released
      // before the disconnect completes. Without this, an immediate
      // reconnect can hit EADDRINUSE on the same ports.
      await portForwardManager!.removeAllForwards(args.targetId)
      session.detach()
      activeSessions.delete(args.targetId)
      clearRelayLostBackoff(args.targetId)
    }
    await connectionManager!.disconnect(args.targetId)
  })

  ipcMain.handle('ssh:terminateSessions', async (_event, args: { targetId: string }) => {
    const session = activeSessions.get(args.targetId)
    const provider = getSshPtyProvider(args.targetId)
    const leasedIds = store
      .getSshRemotePtyLeases(args.targetId)
      .filter((lease) => lease.state !== 'terminated' && lease.state !== 'expired')
      .map((lease) => lease.ptyId)
    const ptyIds = Array.from(new Set([...getPtyIdsForConnection(args.targetId), ...leasedIds]))

    if (ptyIds.length > 0 && !provider) {
      throw new Error(
        `${SSH_TERMINATE_RECONNECT_REQUIRED}: SSH relay is not connected; reconnect before terminating remote sessions.`
      )
    }
    const shutdownResults = provider
      ? await Promise.allSettled(
          ptyIds.map((ptyId) => provider.shutdown(ptyId, { immediate: true, keepHistory: false }))
        )
      : []
    const shutdownFailures: string[] = []
    for (const [index, result] of shutdownResults.entries()) {
      const ptyId = ptyIds[index]
      if (result.status !== 'fulfilled' && !isSshPtyNotFoundError(result.reason)) {
        shutdownFailures.push(
          `${ptyId}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
        )
        continue
      }
      clearProviderPtyState(ptyId)
      deletePtyOwnership(ptyId)
      store.markSshRemotePtyLease(args.targetId, ptyId, 'terminated')
    }
    if (shutdownFailures.length > 0) {
      // Why: a failed relay shutdown can leave the remote process alive in the
      // grace window. Keep the lease/session intact so the user can retry.
      throw new Error(`Failed to terminate remote SSH sessions: ${shutdownFailures.join('; ')}`)
    }
    if (session) {
      await portForwardManager!.removeAllForwards(args.targetId)
      session.dispose()
      activeSessions.delete(args.targetId)
      clearRelayLostBackoff(args.targetId)
    }
    await connectionManager!.disconnect(args.targetId)
  })

  ipcMain.handle('ssh:getState', (_event, args: { targetId: string }) => {
    return connectionManager!.getState(args.targetId)
  })

  // Why: callers that want to auto-connect (Cmd+J jump, terminal reattach) need
  // to know whether doing so will pop a passphrase/password dialog. Auto-firing
  // the connect is fine when no prompt is needed, but surprising otherwise —
  // the user expects to enter the credential before the app starts connecting.
  // Returns true if the target's last successful connect required a credential
  // AND the live SshConnection (if any) does not already have one cached.
  ipcMain.handle('ssh:needsPassphrasePrompt', (_event, args: { targetId: string }) => {
    const target = sshStore!.getTarget(args.targetId)
    if (!target?.lastRequiredPassphrase) {
      return false
    }
    const conn = connectionManager!.getConnection(args.targetId)
    return !conn?.hasCachedCredential()
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
    // Also guard 'reconnecting' — disconnect() would kill the SSH connection
    // that the in-flight reconnect is using for relay deployment.
    const existingSession = activeSessions.get(args.targetId)
    const sessionState = existingSession?.getState()
    if (
      sessionState === 'ready' ||
      sessionState === 'deploying' ||
      sessionState === 'reconnecting'
    ) {
      return { success: true, state: connectionManager!.getState(args.targetId) }
    }

    // Why: if a real ssh:connect is in flight for this target, testConnection's
    // disconnect() call would tear down the connection that doConnect is using
    // for relay deployment. Wait for the in-flight connect to finish instead.
    const inFlight = connectInFlight.get(args.targetId)
    if (inFlight) {
      try {
        const state = await inFlight
        return { success: true, state }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }
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
      // Why: the shared onCredentialRequest callback adds to this set for
      // any connect() call, including testConnection. Without clearing it,
      // a later real connect that doesn't prompt would persist
      // lastRequiredPassphrase=true, causing startup to defer this target.
      credentialRequestedForTarget.delete(args.targetId)
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
      const entry = await portForwardManager!.addForward(
        args.targetId,
        conn,
        args.localPort,
        args.remoteHost,
        args.remotePort,
        args.label
      )
      persistPortForwards(args.targetId)
      broadcastPortForwards(getMainWindow, args.targetId)
      return entry
    }
  )

  ipcMain.handle(
    'ssh:updatePortForward',
    async (
      _event,
      args: {
        id: string
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
      try {
        const entry = await portForwardManager!.updateForward(
          args.id,
          conn,
          args.localPort,
          args.remoteHost,
          args.remotePort,
          args.label
        )
        persistPortForwards(entry.connectionId)
        broadcastPortForwards(getMainWindow, entry.connectionId)
        return entry
      } catch (err) {
        // Why: if the edit failed (and rollback may also have failed),
        // sync the renderer with the actual runtime state so it doesn't
        // show a forward that no longer exists.
        persistPortForwards(args.targetId)
        broadcastPortForwards(getMainWindow, args.targetId)
        throw err
      }
    }
  )

  ipcMain.handle('ssh:removePortForward', (_event, args: { id: string }) => {
    const removed = portForwardManager!.removeForward(args.id)
    if (removed) {
      persistPortForwards(removed.connectionId)
      broadcastPortForwards(getMainWindow, removed.connectionId)
    }
    return removed
  })

  ipcMain.handle('ssh:listPortForwards', (_event, args?: { targetId?: string }) => {
    return portForwardManager!.listForwards(args?.targetId)
  })

  ipcMain.handle('ssh:listDetectedPorts', (_event, args: { targetId: string }) => {
    const session = activeSessions.get(args.targetId)
    return session?.getPortScanner()?.getDetectedPorts(args.targetId) ?? []
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
