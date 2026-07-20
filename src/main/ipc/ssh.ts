/* oxlint-disable max-lines -- Why: co-locates SSH IPC handlers, port-forward broadcasting, and session lifecycle to keep the data flow obvious. */
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
  SshRepoReadoption,
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
  'ssh:listRemovedTargetLabels',
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

// Why: keep this outside registerSshHandlers so a BrowserWindow recreation mid-connect doesn't split credential tracking.
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

/** Public targets for runtime RPC clients — same list the desktop renderer gets. */
export function listRegisteredSshTargets(): SshTarget[] {
  return sshStore?.listTargets() ?? []
}

/** Removed-target id → last known label, for ghost-host display on paired clients. */
export function listRegisteredRemovedSshTargetLabels(): Record<string, string> {
  return sshStore?.listRemovedTargetLabels() ?? {}
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
  // Why: removal is destructive — dispose() (not detach()) so the relay shuts down and remote PTY leases are terminated, not preserved for a reattach.
  await disposeActiveSshSession(targetId)
  try {
    await connectionManager?.disconnect(targetId)
  } catch (err) {
    // Why: a failed disconnect must not block metadata removal, else the target lingers in the store with uncleaned leases.
    console.warn(
      `[ssh] Failed to disconnect removed target ${targetId}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  persistedStore?.removeSshRemotePtyLeases(targetId)
  sshStore.removeTarget(targetId)
}

// One session per SSH target owns the whole relay lifecycle (mux, providers, abort controller, state machine).
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
  // Why: await port teardown so local listeners are released before disconnect/remove completes, else an immediate reconnect hits EADDRINUSE.
  await portForwardManager?.removeAllForwards(targetId)
  teardown(session)
  activeSessions.delete(targetId)
  clearRelayLostBackoff(targetId)
  clearRelayStateOverride(targetId)
}

function relayGracePeriodForTarget(target: SshTarget | null | undefined): number | undefined {
  return target?.relayGracePeriodSeconds
}

// Why: concurrent ssh:connect from multiple tabs would each create a session (leaking the first); hold the in-flight promise so the second awaits it.
const connectInFlight = new Map<string, Promise<SshConnectionState>>()

// Why: publish reset's teardown/force-stop/disconnect lifecycle so new connects and duplicate resets can't race it.
const resetRelayInFlight = new Map<string, Promise<void>>()

// Why: ssh:testConnection connects then disconnects; suppressing broadcasts during the test avoids worktree cards flashing connected → disconnected.
const testingTargets = new Set<string>()

// Why: without backoff, a relay channel that keeps dying reconnects as fast as the network allows, hammering local + remote sshd; track attempts and back off to end the loop recoverably.
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
// Why: a reconnect whose mux dies within this window was a flap, not a recovery — don't reset the attempt counter. 5s covers provider re-registration + PTY reattach.
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
  // Why: runtime-owned (ephemeral-VM) targets are hidden from the renderer, so broadcasting their state only triggers wasted listTargets() lookups.
  if (isRuntimeOwnedSshTargetId(targetId)) {
    currentRuntime?.invalidateSshWorktreeScanCache?.(targetId)
    return
  }
  const enrichedState = withSshRemotePlatform(targetId, state)
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('ssh:state-changed', { targetId, state: enrichedState })
  }
  // Why: paired remote clients have no ssh:state-changed IPC; without this their terminals keep a stale reconnect overlay.
  currentRuntime?.notifySshStateChanged?.(targetId, enrichedState)
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

function connectionSupportsFolderDownload(targetId: string): boolean {
  // Why: connections without an explicit transport are ssh2-shaped; only a confirmed system-SSH transport lacks the SFTP-only capability.
  return connectionManager?.getConnection(targetId)?.usesSystemSshTransport?.() !== true
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

// Why: after user add/remove/update the runtime manager is the source of truth — persist exactly its entries (unrestored ones handled by a separate helper).
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

// Why: keep forwards that failed to restore in the persisted list so they retry on next reconnect instead of being silently dropped.
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

  // Why: keep failed restores in persisted state — a failure may be transient (port temporarily busy), so retry on next reconnect.
  for (const saved of target.portForwards) {
    // Why: a reconnect mid-loop swaps the connection object; bail on identity change so we don't add forwards to a stale conn (leaking listeners).
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
  // Why: SSH port scans only emit on raw host/port/PID changes, but a terminal can print the advertised URL later, so the watcher must also refresh the renderer.
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
        // Why: watcher changes can arrive before the next SSH scan refreshes listener PIDs, so don't validate PIDs against cached scanner rows.
        broadcastDetectedPorts(getMainWindow, targetId, scanner.getDetectedPorts(targetId), {
          validatePid: false
        })
      }
      broadcastPortForwards(getMainWindow, targetId)
    }
  })
}

// Why: macOS can resume before the network is back, so a failed first probe gets one retry before the link is declared dead (#7773).
const RESUME_PROBE_TIMEOUT_MS = 5_000
const RESUME_PROBE_ATTEMPTS = 2

async function isRelayLinkAliveAfterResume(session: SshRelaySession): Promise<boolean> {
  const mux = session.getMux()
  if (!mux || mux.isDisposed()) {
    return false
  }
  for (let attempt = 0; attempt < RESUME_PROBE_ATTEMPTS; attempt++) {
    if (await mux.probeLiveness(RESUME_PROBE_TIMEOUT_MS)) {
      return true
    }
  }
  return false
}

function registerPowerMonitorReconnect(): void {
  powerMonitorUnsubscribe?.()
  const onSuspend = (): void => {
    for (const session of activeSessions.values()) {
      session.prepareForHostSleep()
    }
  }
  const onResume = (): void => {
    for (const [targetId, session] of activeSessions) {
      const manager = connectionManager
      const conn = manager?.getConnection(targetId)
      if (!conn) {
        continue
      }
      void (async () => {
        // Why: unconditional reconnect on wake tore down live sessions and flashed the overlay (#7773); only reconnect if the relay link actually died during sleep.
        if (await isRelayLinkAliveAfterResume(session)) {
          return
        }
        // Why: the probe can take ~10s; bail if the session/connection was replaced or torn down meanwhile, else we'd resurrect it.
        if (activeSessions.get(targetId) !== session || manager?.getConnection(targetId) !== conn) {
          return
        }
        try {
          await manager?.reconnect(targetId)
        } catch (err) {
          console.warn(
            `[ssh] Failed to reconnect ${targetId} after system resume: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      })()
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

      // Why: an SSH reconnect must re-deploy the relay and rebuild providers; the guard below fires only for real reconnects, not an explicit connect's 'deploying'.
      const session = activeSessions.get(targetId)
      const sessionState = session?.getState()
      const shouldReconnectRelay =
        session !== undefined &&
        state.status === 'connected' &&
        state.reconnectAttempt === 0 &&
        (sessionState === 'ready' || sessionState === 'reconnecting')

      if (shouldReconnectRelay) {
        // Why: SSH connects before the relay providers rebuild; keep renderer actions gated until SshRelaySession reaches ready again.
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
      // Why: allow reconnect from both 'ready' and 'reconnecting'; without the latter, a failed relay deploy would permanently brick the session.
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

    // Why: bounded exponential backoff — without it, a remote bug that closes every fresh --connect channel becomes an infinite relay-deploy loop.
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
      // Why: surface the failure — a live SSH connection with a dead relay is otherwise invisible (typing in remote terminals just stops working).
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

  // Why: fires after both establish() and reconnect() reach 'ready'; re-create persisted port forwards so they survive restarts and blips.
  session.setOnReady((tid) => {
    const state = relayLostBackoff.get(tid)
    if (state) {
      if (state.stabilizedTimer) {
        clearTimeout(state.stabilizedTimer)
      }
      // Why: stabilization counts post-ready uptime; slow deploy time before `ready` doesn't prove the new relay survived real work.
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
        reconnectAttempt: 0,
        supportsFolderDownload: connectionSupportsFolderDownload(tid)
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
  // Why: macOS re-activation re-calls this with a new BrowserWindow; ipcMain.handle() throws on a duplicate channel, so remove prior handlers first.
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

  // Why: add/import can re-adopt workspaces orphaned on a removed target id (see ssh-target-readoption); the renderer must refresh its repo list to surface them.
  function takeRepoReadoptions(): SshRepoReadoption[] {
    if (!sshStore || sshStore.lastRepoReadoptions.length === 0) {
      return []
    }
    const repoReadoptions = sshStore.lastRepoReadoptions
    sshStore.lastRepoReadoptions = []
    const win = getCurrentMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('repos:changed')
    }
    return repoReadoptions
  }

  ipcMain.handle('ssh:listTargets', () => {
    return sshStore!.listTargets()
  })

  ipcMain.handle('ssh:listRemovedTargetLabels', () => {
    return sshStore!.listRemovedTargetLabels()
  })

  ipcMain.handle('ssh:addTarget', (_event, args: { target: Omit<SshTarget, 'id'> }) => {
    const target = sshStore!.addTarget(args.target)
    // Why: re-adding a removed host can re-adopt orphaned workspaces; refresh the renderer's repo list so they move back onto the live host.
    const repoReadoptions = takeRepoReadoptions()
    return { target, repoReadoptions }
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
    const targets = sshStore!.importFromSshConfig(args)
    const repoReadoptions = takeRepoReadoptions()
    return { targets, repoReadoptions }
  })

  // ── Connection lifecycle ───────────────────────────────────────────

  async function connectTarget(targetId: string): Promise<SshConnectionState> {
    const reset = resetRelayInFlight.get(targetId)
    if (reset) {
      await reset
    }

    // Why: serialize concurrent ssh:connect for the same target; interleaved connects otherwise leak the first session.
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
      // Why: BrowserWindow reactivation re-fires ssh:connect for already-live targets; treat as a refresh instead of tearing down the relay and its forwards.
      broadcastSshState(getCurrentMainWindow, targetId, existingState)
      return existingState
    }

    clearRelayStateOverride(targetId)
    let conn
    // Why: tear down any existing session first to avoid leaking its multiplexer, providers, and timers (double-connect / reconnect-after-error).
    if (existingSession) {
      // Why: await port teardown before disposing, else the new session's restorePortForwards can hit EADDRINUSE on not-yet-released ports.
      await portForwardManager!.removeAllForwards(targetId)
      existingSession.detach()
      activeSessions.delete(targetId)
      clearRelayLostBackoff(targetId)
      clearRelayStateOverride(targetId)
    }

    // Why: create the session early so onStateChange sees it in 'deploying' and skips reconnect logic.
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
      // Why: connect()'s internal state may not have reached the renderer; broadcast explicitly so the UI leaves 'connecting'.
      const errObj = err instanceof Error ? err : new Error(String(err))
      const status: SshConnectionStatus = isAuthError(errObj) ? 'auth-failed' : 'error'
      // Why: clear this failed connect's credential flag so a later non-prompting connect can't persist lastRequiredPassphrase=true.
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
      callbacks.onStateChange(targetId, {
        targetId,
        status: 'deploying-relay',
        error: null,
        reconnectAttempt: 0
      })

      await session.establish(conn, relayGracePeriodForTarget(target))

      // Why: we manually pushed `deploying-relay`, so send `connected` straight to the renderer — routing through onStateChange would trigger reconnect logic.
      clearRelayStateOverride(targetId)
      broadcastSshState(getCurrentMainWindow, targetId, {
        targetId,
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        supportsFolderDownload: conn.usesSystemSshTransport?.() !== true
      })
    } catch (err) {
      activeSessions.delete(targetId)
      clearRelayLostBackoff(targetId)
      await connectionManager!.disconnect(targetId)
      throw err
    }

    // Why: persist whether this connect needed a credential so startup can partition targets into eager vs deferred without re-probing keys.
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
      // Why: a failed relay shutdown can leave the remote process alive in the grace window; keep the lease/session so the user can retry.
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
        // Why: await the in-flight connect first; tearing down activeSessions mid-deploy would dispose the session doConnect is about to use.
        await inFlightConnect
      } catch {
        // The reset can still recover a stale remote relay after a failed connect.
      }
    }

    const session = activeSessions.get(targetId)
    if (session) {
      await portForwardManager!.removeAllForwards(targetId)
      // Why: detach() not dispose() — reset has its own stale-lease semantics below that dispose()'s clean-termination recording would hide.
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
      // Why: reset force-kills the remote relay, so every local PTY handle it owned is stale even if the reset command failed after SIGTERM.
      for (const ptyId of ptyIds) {
        const appPtyId = toAppSshPtyId(targetId, ptyId)
        clearProviderPtyState(appPtyId)
        deletePtyOwnership(appPtyId)
      }
      // Why: reset's connect() may trip onCredentialRequest; clear so a later non-prompting doConnect doesn't persist lastRequiredPassphrase=true.
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

  // Why: auto-connect callers need to know whether connecting will prompt; true when the last connect required a credential and no live conn has it cached.
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

    // Why: with a live/reconnecting session, testConnection's disconnect() would tear down the relay stack (PTYs, watchers), so skip.
    const existingSession = activeSessions.get(args.targetId)
    const sessionState = existingSession?.getState()
    if (
      sessionState === 'ready' ||
      sessionState === 'deploying' ||
      sessionState === 'reconnecting'
    ) {
      return { success: true, state: connectionManager!.getState(args.targetId) }
    }

    // Why: testConnection's disconnect() would tear down an in-flight connect's relay deployment; await it instead.
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
      // Why: clear so a test's credential prompt doesn't leave lastRequiredPassphrase=true and defer this target at startup.
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
        // Why: edit/rollback may have failed, so resync renderer to actual runtime state.
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
      // Why: cross-target entries can't be mapped to worktrees in one call, so serve the raw list.
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
