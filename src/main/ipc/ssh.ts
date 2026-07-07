/* oxlint-disable max-lines -- Why: co-locates SSH IPC handlers, port-forward
broadcasting, and session lifecycle in one file to keep the data flow obvious. */
import { ipcMain, powerMonitor, type BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { SshConnectionStore } from '../ssh/ssh-connection-store'
import { SshConnectionManager, type SshConnectionCallbacks } from '../ssh/ssh-connection'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { SshRelaySession, type SshRelayAiVaultHostInfo } from '../ssh/ssh-relay-session'
import { SshPortForwardManager } from '../ssh/ssh-port-forward'
import type {
  DetectedPort,
  EnrichedDetectedPort,
  SavedPortForward,
  SshTarget,
  SshConnectionStatus,
  SshConnectionState
} from '../../shared/ssh-types'
import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../shared/constants'
import { isRuntimeOwnedSshTargetId } from '../../shared/execution-host'
import { isAuthError } from '../ssh/ssh-connection-utils'
import { forceStopRelayForTarget } from '../ssh/ssh-relay-reset'
import { isSshPtyNotFoundError } from '../providers/ssh-pty-provider'
import { toAppSshPtyId, toRelaySshPtyId } from '../providers/ssh-pty-id'
import { registerSshBrowseHandler } from './ssh-browse'
import {
  getConnectionIdsForWorktree,
  enrichSshDetectedPorts,
  enrichSshForwardEntries,
  getWorktreeIdsForConnection
} from '../ports/ssh-advertised-url-enrichment'
import { advertisedUrlWatcher } from '../ports/advertised-url-watcher'
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
let registeredConnectSshTarget: ((targetId: string) => Promise<SshConnectionState>) | null = null
let registeredGetSshState: ((targetId: string) => SshConnectionState | undefined) | null = null
let persistedStore: Store | null = null
let advertisedUrlWatcherUnsubscribe: (() => void) | null = null
let powerMonitorUnsubscribe: (() => void) | null = null
let currentGetMainWindow: () => BrowserWindow | null = () => null
let currentRuntime: OrcaRuntimeService | undefined

const SSH_IPC_CHANNELS = [
  'ssh:listTargets',
  'ssh:addTarget',
  'ssh:updateTarget',
  'ssh:removeTarget',
  'ssh:importConfig',
  'ssh:connect',
  'ssh:disconnect',
  'ssh:terminateSessions',
  'ssh:resetRelay',
  'ssh:getState',
  'ssh:needsPassphrasePrompt',
  'ssh:testConnection',
  'ssh:addPortForward',
  'ssh:updatePortForward',
  'ssh:removePortForward',
  'ssh:listPortForwards',
  'ssh:listDetectedPorts'
] as const

// Why: connection callbacks are process-lifetime; keeping this set outside
// registerSshHandlers prevents in-flight connects from splitting credential
// tracking when a BrowserWindow is recreated.
const credentialRequestedForTarget = new Set<string>()

function getCurrentMainWindow(): BrowserWindow | null {
  return currentGetMainWindow()
}

export async function connectRegisteredSshTarget(targetId: string): Promise<SshConnectionState> {
  if (!registeredConnectSshTarget) {
    throw new Error('ssh_handlers_not_registered')
  }
  return registeredConnectSshTarget(targetId)
}

export function getRegisteredSshState(targetId: string): SshConnectionState | undefined {
  return registeredGetSshState?.(targetId)
}

export async function disconnectRegisteredSshTarget(targetId: string): Promise<void> {
  if (!connectionManager) {
    return
  }
  await detachActiveSshSession(targetId)
  await connectionManager.disconnect(targetId)
}

export async function removeRegisteredSshTarget(targetId: string): Promise<void> {
  if (!sshStore) {
    return
  }
  // Why: removing a target is destructive — dispose() (not detach()) so the
  // relay shuts down and remote PTY leases are terminated rather than preserved
  // for a reattach to a target that will no longer exist.
  await disposeActiveSshSession(targetId)
  try {
    await connectionManager?.disconnect(targetId)
  } catch (err) {
    // Why: a failed disconnect must not block metadata removal; otherwise the
    // target lingers in the store and its leases are never cleaned up.
    console.warn(
      `[ssh] Failed to disconnect removed target ${targetId}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  persistedStore?.removeSshRemotePtyLeases(targetId)
  sshStore.removeTarget(targetId)
}

// Why: one session per SSH target encapsulates the entire relay lifecycle
// (multiplexer, providers, abort controller, state machine). Eliminates the
// scattered Maps/Sets that previously tracked this state independently.
const activeSessions = new Map<string, SshRelaySession>()

export function getActiveSshAiVaultHostInfo(targetId: string): SshRelayAiVaultHostInfo | null {
  if (isRuntimeOwnedSshTargetId(targetId)) {
    return null
  }
  return activeSessions.get(targetId)?.getAiVaultHostInfo() ?? null
}

export function getActiveSshAiVaultHostInfos(): SshRelayAiVaultHostInfo[] {
  return [...activeSessions.values()].flatMap((session) => {
    if (isRuntimeOwnedSshTargetId(session.targetId)) {
      return []
    }
    const info = session.getAiVaultHostInfo()
    return info ? [info] : []
  })
}

async function detachActiveSshSession(targetId: string): Promise<void> {
  await teardownActiveSshSession(targetId, (session) => session.detach())
}

async function disposeActiveSshSession(targetId: string): Promise<void> {
  await teardownActiveSshSession(targetId, (session) => session.dispose())
}

async function teardownActiveSshSession(
  targetId: string,
  teardown: (session: SshRelaySession) => void
): Promise<void> {
  const session = activeSessions.get(targetId)
  if (!session) {
    return
  }
  // Why: await port teardown so local listeners are fully released before
  // disconnect/remove completes; otherwise immediate reconnect can hit EADDRINUSE.
  await portForwardManager?.removeAllForwards(targetId)
  teardown(session)
  activeSessions.delete(targetId)
  clearRelayLostBackoff(targetId)
  clearRelayStateOverride(targetId)
}

function relayGracePeriodForTarget(target: SshTarget | null | undefined): number | undefined {
  return target?.relayGracePeriodSeconds
}

// Why: multiple renderer tabs for the same SSH target can fire ssh:connect
// concurrently. Without serialization, the second call interleaves with the
// first — both see no existing session, both create one, and the first one
// leaks. This map holds the in-flight connect promise so the second call
// awaits the first rather than racing.
const connectInFlight = new Map<string, Promise<SshConnectionState>>()

// Why: reset tears down and force-stops the relay, then disconnects SSH.
// Publish that lifecycle so new connects and duplicate resets cannot race it.
const resetRelayInFlight = new Map<string, Promise<void>>()

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
// post-ready uptime resets the attempt counter for the next genuine drop.
type RelayLostBackoffState = {
  attempts: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  stabilizedTimer: ReturnType<typeof setTimeout> | null
}
const relayLostBackoff = new Map<string, RelayLostBackoffState>()
const relayStateOverrides = new Map<string, SshConnectionState>()
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
  if (state?.reconnectTimer) {
    clearTimeout(state.reconnectTimer)
  }
  if (state?.stabilizedTimer) {
    clearTimeout(state.stabilizedTimer)
  }
  relayLostBackoff.delete(targetId)
}

function broadcastSshState(
  getMainWindow: () => BrowserWindow | null,
  targetId: string,
  state: SshConnectionState
): void {
  // Why: runtime-owned (ephemeral-VM) targets are hidden from the renderer, which
  // has no surface for them. Broadcasting their state would make the renderer fire
  // a listTargets() lookup per event (incl. each relay-lost reconnect) for nothing.
  if (isRuntimeOwnedSshTargetId(targetId)) {
    return
  }
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('ssh:state-changed', {
      targetId,
      state: withSshRemotePlatform(targetId, state)
    })
  }
}

function withSshRemotePlatform(targetId: string, state: SshConnectionState): SshConnectionState {
  const remotePlatform = activeSessions.get(targetId)?.getHostPlatform()?.os
  return remotePlatform ? { ...state, remotePlatform } : state
}

function publishRelayOverride(
  getMainWindow: () => BrowserWindow | null,
  targetId: string,
  status: SshConnectionStatus,
  error: string | null,
  reconnectAttempt: number
): void {
  const state = withSshRemotePlatform(targetId, { targetId, status, error, reconnectAttempt })
  relayStateOverrides.set(targetId, state)
  broadcastSshState(getMainWindow, targetId, state)
}

function clearRelayStateOverride(targetId: string): void {
  relayStateOverrides.delete(targetId)
}

function getPublicSshState(targetId: string): SshConnectionState | undefined {
  const state = relayStateOverrides.get(targetId) ?? connectionManager!.getState(targetId)
  return state ? withSshRemotePlatform(targetId, state) : undefined
}

function broadcastPortForwards(getMainWindow: () => BrowserWindow | null, targetId: string): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    return
  }
  win.webContents.send('ssh:port-forwards-changed', {
    targetId,
    forwards: listForwardsEnriched(targetId)
  })
}

function broadcastDetectedPorts(
  getMainWindow: () => BrowserWindow | null,
  targetId: string,
  ports: DetectedPort[],
  options?: Parameters<typeof enrichSshDetectedPorts>[3]
): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    return
  }
  win.webContents.send('ssh:detected-ports-changed', {
    targetId,
    ports: enrichDetected(targetId, ports, options)
  })
}

function listForwardsEnriched(targetId: string): ReturnType<SshPortForwardManager['listForwards']> {
  const raw = portForwardManager!.listForwards(targetId)
  if (!persistedStore) {
    return raw
  }
  return enrichSshForwardEntries(raw, getWorktreeIdsForConnection(persistedStore, targetId))
}

function enrichDetected(
  targetId: string,
  ports: DetectedPort[],
  options?: Parameters<typeof enrichSshDetectedPorts>[3]
): EnrichedDetectedPort[] {
  if (!persistedStore) {
    return ports
  }
  return enrichSshDetectedPorts(
    ports,
    getWorktreeIdsForConnection(persistedStore, targetId),
    undefined,
    options
  )
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

function registerAdvertisedUrlRefresh(getMainWindow: () => BrowserWindow | null): void {
  advertisedUrlWatcherUnsubscribe?.()
  // Why: SSH port scans only emit when raw host/port/PID data changes. A
  // terminal can print the advertised URL after the raw port row is already
  // visible, so the watcher must also trigger a renderer refresh.
  advertisedUrlWatcherUnsubscribe = advertisedUrlWatcher.onDidChange(({ worktreeId }) => {
    if (!persistedStore) {
      return
    }
    for (const targetId of getConnectionIdsForWorktree(persistedStore, worktreeId)) {
      const session = activeSessions.get(targetId)
      if (!session) {
        continue
      }
      const scanner = session.getPortScanner()
      if (scanner) {
        // Why: watcher changes can arrive before the next SSH scan refreshes
        // listener PIDs; cached scanner rows must not pin a fresh URL stale.
        broadcastDetectedPorts(getMainWindow, targetId, scanner.getDetectedPorts(targetId), {
          validatePid: false
        })
      }
      broadcastPortForwards(getMainWindow, targetId)
    }
  })
}

function registerPowerMonitorReconnect(): void {
  powerMonitorUnsubscribe?.()
  const onSuspend = (): void => {
    for (const session of activeSessions.values()) {
      session.prepareForHostSleep()
    }
  }
  const onResume = (): void => {
    for (const targetId of activeSessions.keys()) {
      const conn = connectionManager?.getConnection(targetId)
      if (!conn) {
        continue
      }
      const reconnect = connectionManager?.reconnect(targetId)
      void reconnect?.catch((err) => {
        console.warn(
          `[ssh] Failed to reconnect ${targetId} after system resume: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      })
    }
  }
  powerMonitor.on('suspend', onSuspend)
  powerMonitor.on('resume', onResume)
  powerMonitorUnsubscribe = () => {
    powerMonitor.off('suspend', onSuspend)
    powerMonitor.off('resume', onResume)
  }
}

function createSshConnectionCallbacks(): SshConnectionCallbacks {
  return {
    onCredentialRequest: (targetId, kind, detail) => {
      credentialRequestedForTarget.add(targetId)
      return requestCredential(getCurrentMainWindow, targetId, kind, detail)
    },
    onStateChange: (targetId: string, state: SshConnectionState) => {
      if (testingTargets.has(targetId)) {
        return
      }

      // Why: when SSH reconnects after a network blip, we must re-deploy the
      // relay and rebuild the full provider stack. The session's state machine
      // ensures this only triggers when appropriate — 'deploying' state from
      // an explicit ssh:connect is not 'ready', so this branch won't fire.
      const session = activeSessions.get(targetId)
      const sessionState = session?.getState()
      const shouldReconnectRelay =
        session !== undefined &&
        state.status === 'connected' &&
        state.reconnectAttempt === 0 &&
        (sessionState === 'ready' || sessionState === 'reconnecting')

      if (shouldReconnectRelay) {
        // Why: SSH is connected before the relay providers are rebuilt. Keep
        // renderer actions gated until SshRelaySession reaches ready again.
        publishRelayOverride(
          getCurrentMainWindow,
          targetId,
          'reconnecting',
          'Relay channel reconnecting...',
          state.reconnectAttempt
        )
      } else {
        clearRelayStateOverride(targetId)
        broadcastSshState(getCurrentMainWindow, targetId, state)
      }

      if (!session) {
        return
      }
      // Why: allow reconnect from both 'ready' (normal network blip) and
      // 'reconnecting' (previous reconnect attempt failed, e.g. relay deploy
      // error on a working SSH connection). Without the 'reconnecting' check,
      // a failed relay deploy would permanently brick the session.
      if (shouldReconnectRelay) {
        const target = sshStore?.getTarget(targetId)
        const conn = connectionManager?.getConnection(targetId)
        if (conn) {
          void session.reconnect(conn, relayGracePeriodForTarget(target))
        }
      }
    }
  }
}

function broadcastDetectedPortsFromCurrentWindow(
  targetId: string,
  ports: DetectedPort[],
  _platform: string
): void {
  broadcastDetectedPorts(getCurrentMainWindow, targetId, ports)
}

function configureRelaySessionCallbacks(session: SshRelaySession): void {
  session.setOnTerminalRelayError((tid, err) => {
    clearRelayLostBackoff(tid)
    console.warn(
      `[ssh] Terminal relay error for ${tid}: ${err.message}; skipping reconnect backoff.`
    )
    publishRelayOverride(getCurrentMainWindow, tid, 'error', err.message, 0)
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
      reconnectTimer: null,
      stabilizedTimer: null
    }
    if (state.stabilizedTimer) {
      clearTimeout(state.stabilizedTimer)
      state.stabilizedTimer = null
    }
    if (state.reconnectTimer) {
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
      publishRelayOverride(
        getCurrentMainWindow,
        tid,
        'error',
        'Relay channel kept dropping. Click Reconnect on the SSH target before retrying.',
        0
      )
      return
    }
    const delay = Math.min(RELAY_LOST_BASE_DELAY_MS * 2 ** state.attempts, RELAY_LOST_MAX_DELAY_MS)
    state.attempts += 1
    publishRelayOverride(
      getCurrentMainWindow,
      tid,
      'reconnecting',
      'Relay channel lost. Reconnecting...',
      state.attempts
    )
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null
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
  // and network blips without manual re-configuration.
  session.setOnReady((tid) => {
    const state = relayLostBackoff.get(tid)
    if (state) {
      if (state.stabilizedTimer) {
        clearTimeout(state.stabilizedTimer)
      }
      // Why: stabilization is post-ready uptime. Slow deployment time before
      // `ready` does not prove the new relay survived user-visible work.
      state.stabilizedTimer = setTimeout(() => {
        const current = relayLostBackoff.get(tid)
        if (current === state && !current.reconnectTimer) {
          relayLostBackoff.delete(tid)
        }
      }, RELAY_LOST_STABILIZED_MS)
      relayLostBackoff.set(tid, state)
    }
    clearRelayStateOverride(tid)
    if (!testingTargets.has(tid)) {
      broadcastSshState(getCurrentMainWindow, tid, {
        targetId: tid,
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })
    }
    void restorePortForwards(tid, getCurrentMainWindow)
  })
}

function refreshActiveRelaySessions(): void {
  if (!persistedStore || !portForwardManager) {
    return
  }
  for (const session of activeSessions.values()) {
    session.refreshEnvironment(
      getCurrentMainWindow,
      persistedStore,
      portForwardManager,
      currentRuntime,
      broadcastDetectedPortsFromCurrentWindow
    )
    configureRelaySessionCallbacks(session)
  }
}

export function registerSshHandlers(
  store: Store,
  getMainWindow: () => BrowserWindow | null,
  runtime?: OrcaRuntimeService
): { connectionManager: SshConnectionManager; sshStore: SshConnectionStore } {
  // Why: on macOS, app re-activation creates a new BrowserWindow and re-calls
  // this function. ipcMain.handle() throws if a handler is already registered,
  // so we must remove any prior handlers before re-registering.
  for (const ch of SSH_IPC_CHANNELS) {
    ipcMain.removeHandler(ch)
  }

  currentGetMainWindow = getMainWindow
  currentRuntime = runtime
  sshStore = new SshConnectionStore(store)
  persistedStore = store
  registerAdvertisedUrlRefresh(getCurrentMainWindow)

  registerCredentialHandler(getCurrentMainWindow)

  const callbacks = createSshConnectionCallbacks()
  if (connectionManager) {
    connectionManager.setCallbacks(callbacks)
  } else {
    connectionManager = new SshConnectionManager(callbacks)
  }
  portForwardManager ??= new SshPortForwardManager()
  portForwardManager.setCallbacks({
    onForwardClosed: (entry, reason) => {
      if (reason.kind === 'unexpected-exit') {
        console.warn(
          `[ssh] Port forward ${entry.localPort} → ${entry.remoteHost}:${entry.remotePort} closed unexpectedly${
            reason.detail ? `: ${reason.detail}` : ''
          }`
        )
      }
      persistPortForwardsWithUnrestored(entry.connectionId)
      broadcastPortForwards(getCurrentMainWindow, entry.connectionId)
    }
  })
  refreshActiveRelaySessions()
  registerPowerMonitorReconnect()
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
    await removeRegisteredSshTarget(args.id)
  })

  ipcMain.handle('ssh:importConfig', (_event, args?: { reAdopt?: boolean }) => {
    return sshStore!.importFromSshConfig(args)
  })

  // ── Connection lifecycle ───────────────────────────────────────────

  async function connectTarget(targetId: string): Promise<SshConnectionState> {
    const reset = resetRelayInFlight.get(targetId)
    if (reset) {
      await reset
    }

    // Why: serialize concurrent ssh:connect calls for the same target.
    // Multiple tabs can fire connect simultaneously; without this, they
    // interleave and the first session leaks.
    const existing = connectInFlight.get(targetId)
    if (existing) {
      return existing
    }

    const promise = doConnect(targetId)
    connectInFlight.set(targetId, promise)
    try {
      return await promise
    } finally {
      connectInFlight.delete(targetId)
    }
  }

  registeredConnectSshTarget = connectTarget
  registeredGetSshState = (targetId: string) => getPublicSshState(targetId)

  ipcMain.handle('ssh:connect', async (_event, args: { targetId: string }) => {
    return connectTarget(args.targetId)
  })

  async function doConnect(targetId: string): Promise<SshConnectionState> {
    const target = sshStore!.getTarget(targetId)
    if (!target) {
      throw new Error(`SSH target "${targetId}" not found`)
    }

    const existingSession = activeSessions.get(targetId)
    const existingState = connectionManager!.getState(targetId)
    const existingMux = existingSession?.getMux()
    if (
      existingSession?.getState() === 'ready' &&
      existingState?.status === 'connected' &&
      connectionManager!.getConnection(targetId) &&
      existingMux &&
      !existingMux.isDisposed() &&
      !relayStateOverrides.has(targetId) &&
      !relayLostBackoff.has(targetId)
    ) {
      // Why: BrowserWindow reactivation reruns renderer startup, which calls
      // ssh:connect for already-live targets. Treat that as a refresh instead
      // of tearing down the relay and stranding active port forwards.
      broadcastSshState(getCurrentMainWindow, targetId, existingState)
      return existingState
    }

    clearRelayStateOverride(targetId)
    let conn
    // Why: dispose any existing session to avoid leaking the old multiplexer,
    // providers, and timers. This handles double-connect (user clicks connect
    // while already connected) and reconnect-after-error.
    if (existingSession) {
      // Why: await port teardown before disposing so the OS fully releases
      // local ports. Without this, restorePortForwards in the new session
      // can hit EADDRINUSE on the same ports the old session was using.
      await portForwardManager!.removeAllForwards(targetId)
      existingSession.detach()
      activeSessions.delete(targetId)
      clearRelayLostBackoff(targetId)
      clearRelayStateOverride(targetId)
    }

    // Why: create the session early so onStateChange sees it in 'deploying'
    // state and knows not to trigger reconnect logic.
    const session = new SshRelaySession(
      targetId,
      getCurrentMainWindow,
      persistedStore!,
      portForwardManager!,
      currentRuntime,
      broadcastDetectedPortsFromCurrentWindow
    )
    configureRelaySessionCallbacks(session)
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
      clearRelayStateOverride(targetId)
      broadcastSshState(getCurrentMainWindow, targetId, {
        targetId,
        status,
        error: errObj.message,
        reconnectAttempt: 0
      })
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

      await session.establish(conn, relayGracePeriodForTarget(target))

      // Why: we manually pushed `deploying-relay` above, so the renderer's
      // state is stuck there. Send `connected` directly to the renderer
      // instead of going through callbacks.onStateChange, which would
      // trigger the reconnection logic.
      const win = getCurrentMainWindow()
      if (win && !win.isDestroyed()) {
        clearRelayStateOverride(targetId)
        win.webContents.send('ssh:state-changed', {
          targetId,
          state: withSshRemotePlatform(targetId, {
            targetId,
            status: 'connected',
            error: null,
            reconnectAttempt: 0
          })
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

    return getPublicSshState(targetId)!
  }

  ipcMain.handle('ssh:disconnect', async (_event, args: { targetId: string }) => {
    await disconnectRegisteredSshTarget(args.targetId)
  })

  ipcMain.handle('ssh:terminateSessions', async (_event, args: { targetId: string }) => {
    const session = activeSessions.get(args.targetId)
    const provider = getSshPtyProvider(args.targetId)
    const leasedIds = persistedStore!
      .getSshRemotePtyLeases(args.targetId)
      .filter((lease) => lease.state !== 'terminated' && lease.state !== 'expired')
      .map((lease) => lease.ptyId)
    const ptyIdsByRelayId = new Map<string, string>()
    for (const ptyId of getPtyIdsForConnection(args.targetId)) {
      const relayPtyId = toRelaySshPtyId(args.targetId, ptyId)
      ptyIdsByRelayId.set(relayPtyId, toAppSshPtyId(args.targetId, ptyId))
    }
    for (const ptyId of leasedIds) {
      const relayPtyId = toRelaySshPtyId(args.targetId, ptyId)
      ptyIdsByRelayId.set(
        relayPtyId,
        ptyIdsByRelayId.get(relayPtyId) ?? toAppSshPtyId(args.targetId, ptyId)
      )
    }
    const ptyIds = Array.from(ptyIdsByRelayId, ([relayPtyId, appPtyId]) => ({
      relayPtyId,
      appPtyId
    }))

    if (ptyIds.length > 0 && !provider) {
      throw new Error(
        `${SSH_TERMINATE_RECONNECT_REQUIRED}: SSH relay is not connected; reconnect before terminating remote sessions.`
      )
    }
    const shutdownResults = provider
      ? await Promise.allSettled(
          ptyIds.map(({ appPtyId }) =>
            provider.shutdown(appPtyId, { immediate: true, keepHistory: false })
          )
        )
      : []
    const shutdownFailures: string[] = []
    for (const [index, result] of shutdownResults.entries()) {
      const { appPtyId, relayPtyId } = ptyIds[index]
      if (result.status !== 'fulfilled' && !isSshPtyNotFoundError(result.reason)) {
        shutdownFailures.push(
          `${relayPtyId}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
        )
        continue
      }
      clearProviderPtyState(appPtyId)
      deletePtyOwnership(appPtyId)
      persistedStore!.markSshRemotePtyLease(args.targetId, relayPtyId, 'terminated')
    }
    if (shutdownFailures.length > 0) {
      // Why: a failed relay shutdown can leave the remote process alive in the
      // grace window. Keep the lease/session intact so the user can retry.
      throw new Error(`Failed to terminate SSH host sessions: ${shutdownFailures.join('; ')}`)
    }
    if (session) {
      await portForwardManager!.removeAllForwards(args.targetId)
      session.dispose()
      activeSessions.delete(args.targetId)
      clearRelayLostBackoff(args.targetId)
      clearRelayStateOverride(args.targetId)
    }
    await connectionManager!.disconnect(args.targetId)
  })

  async function doResetRelay(targetId: string, target: SshTarget): Promise<void> {
    const inFlightConnect = connectInFlight.get(targetId)
    if (inFlightConnect) {
      try {
        // Why: reset tears down activeSessions; doing that while doConnect is
        // still deploying can dispose the session doConnect is about to use.
        await inFlightConnect
      } catch {
        // The reset can still recover a stale remote relay after a failed connect.
      }
    }

    const session = activeSessions.get(targetId)
    if (session) {
      await portForwardManager!.removeAllForwards(targetId)
      // Why: reset has its own stale-relay lease semantics below. dispose()
      // records clean PTY termination, which hides reset-affected leases.
      session.detach()
      activeSessions.delete(targetId)
      clearRelayLostBackoff(targetId)
    }

    const existingConn = connectionManager!.getConnection(targetId)
    const conn = existingConn ?? (await connectionManager!.connect(target))
    try {
      await forceStopRelayForTarget(conn, targetId)
    } finally {
      const ptyIds = new Set(getPtyIdsForConnection(targetId))
      for (const lease of persistedStore!.getSshRemotePtyLeases(targetId)) {
        if (lease.state !== 'terminated' && lease.state !== 'expired') {
          ptyIds.add(lease.ptyId)
          persistedStore!.markSshRemotePtyLease(targetId, lease.ptyId, 'expired')
        }
      }
      // Why: reset force-kills the remote relay daemon, so every local PTY
      // handle owned by that relay is stale even if the reset command failed
      // after the remote process accepted SIGTERM.
      for (const ptyId of ptyIds) {
        const appPtyId = toAppSshPtyId(targetId, ptyId)
        clearProviderPtyState(appPtyId)
        deletePtyOwnership(appPtyId)
      }
      // Why: reset's connect() can trip onCredentialRequest, which adds to
      // credentialRequestedForTarget. Without this delete, a later doConnect
      // that doesn't prompt would still persist lastRequiredPassphrase=true.
      credentialRequestedForTarget.delete(targetId)
      await connectionManager!.disconnect(targetId)
    }
  }

  ipcMain.handle('ssh:resetRelay', (_event, args: { targetId: string }) => {
    const existingReset = resetRelayInFlight.get(args.targetId)
    if (existingReset) {
      return existingReset
    }

    const target = sshStore!.getTarget(args.targetId)
    if (!target) {
      throw new Error(`SSH target "${args.targetId}" not found`)
    }

    let resetPromise: Promise<void>
    resetPromise = Promise.resolve()
      .then(() => doResetRelay(args.targetId, target))
      .finally(() => {
        if (resetRelayInFlight.get(args.targetId) === resetPromise) {
          resetRelayInFlight.delete(args.targetId)
        }
      })
    resetRelayInFlight.set(args.targetId, resetPromise)
    return resetPromise
  })

  ipcMain.handle('ssh:getState', (_event, args: { targetId: string }) => {
    return getPublicSshState(args.targetId)
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
      broadcastPortForwards(getCurrentMainWindow, args.targetId)
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
        broadcastPortForwards(getCurrentMainWindow, entry.connectionId)
        return entry
      } catch (err) {
        // Why: if the edit failed (and rollback may also have failed),
        // sync the renderer with the actual runtime state so it doesn't
        // show a forward that no longer exists.
        persistPortForwards(args.targetId)
        broadcastPortForwards(getCurrentMainWindow, args.targetId)
        throw err
      }
    }
  )

  ipcMain.handle('ssh:removePortForward', async (_event, args: { id: string }) => {
    const removed = await portForwardManager!.removeForwardAndWait(args.id)
    if (removed) {
      persistPortForwards(removed.connectionId)
      broadcastPortForwards(getCurrentMainWindow, removed.connectionId)
    }
    return removed
  })

  ipcMain.handle('ssh:listPortForwards', (_event, args?: { targetId?: string }) => {
    const all = portForwardManager!.listForwards(args?.targetId)
    if (!persistedStore || !args?.targetId) {
      // Why: the cross-target list is rare and we cannot map every entry to
      // worktrees in a single call; serve the raw list. Per-target callers
      // get full enrichment.
      return all
    }
    return enrichSshForwardEntries(all, getWorktreeIdsForConnection(persistedStore, args.targetId))
  })

  ipcMain.handle('ssh:listDetectedPorts', (_event, args: { targetId: string }) => {
    const session = activeSessions.get(args.targetId)
    const ports = session?.getPortScanner()?.getDetectedPorts(args.targetId) ?? []
    return enrichDetected(args.targetId, ports)
  })

  return { connectionManager, sshStore }
}

export function getSshConnectionManager(): SshConnectionManager | null {
  return connectionManager
}

export async function resetSshHandlerStateForTests(): Promise<void> {
  advertisedUrlWatcherUnsubscribe?.()
  advertisedUrlWatcherUnsubscribe = null
  powerMonitorUnsubscribe?.()
  powerMonitorUnsubscribe = null
  for (const ch of SSH_IPC_CHANNELS) {
    ipcMain.removeHandler(ch)
  }
  ipcMain.removeHandler('ssh:submitCredential')

  for (const session of activeSessions.values()) {
    session.dispose()
  }
  activeSessions.clear()
  for (const targetId of relayLostBackoff.keys()) {
    clearRelayLostBackoff(targetId)
  }
  relayStateOverrides.clear()
  connectInFlight.clear()
  resetRelayInFlight.clear()
  testingTargets.clear()
  credentialRequestedForTarget.clear()

  await connectionManager?.disconnectAll()
  portForwardManager?.dispose()
  connectionManager = null
  portForwardManager = null
  sshStore = null
  persistedStore = null
  registeredConnectSshTarget = null
  registeredGetSshState = null
  currentGetMainWindow = () => null
  currentRuntime = undefined
}

export function getSshConnectionStore(): SshConnectionStore | null {
  return sshStore
}

export function getActiveMultiplexer(connectionId: string): SshChannelMultiplexer | undefined {
  return activeSessions.get(connectionId)?.getMux() ?? undefined
}
