/* oxlint-disable max-lines -- Why: co-locates SSH IPC handlers, port-forward broadcasting, and session lifecycle to keep the data flow obvious. */
import { ipcMain, powerMonitor, type BrowserWindow } from 'electron'
import { appendFileSync } from 'node:fs'
import type { Store } from '../persistence'
import { SshConnectionStore } from '../ssh/ssh-connection-store'
import {
  listUserSshConfigHostSummaries,
  resolveUserSshConfigHost
} from '../ssh/ssh-config-host-picker'
import type { SshConnection, SshConnectionCallbacks } from '../ssh/ssh-connection'
import { SshConnectionManager } from '../ssh/ssh-connection-manager'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { SshRelaySession, type SshRelayAiVaultHostInfo } from '../ssh/ssh-relay-session'
import type {
  SshAiVaultRelayListParams,
  SshAiVaultRelayTitleParams
} from '../../shared/ssh-ai-vault-relay'
import { SshPortForwardManager } from '../ssh/ssh-port-forward'
import type {
  DetectedPort,
  EnrichedDetectedPort,
  SavedPortForward,
  SshConfigHostListArgs,
  SshRepoReadoption,
  SshTarget,
  SshConnectionStatus,
  SshConnectionState,
  DirectSshAuthority
} from '../../shared/ssh-types'
import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../shared/constants'
import { quitTeardownStartGate } from '../quit-teardown-start-gate'
import { isRuntimeOwnedSshTargetId } from '../../shared/execution-host'
import { isAuthError } from '../ssh/ssh-connection-utils'
import { createCancelledConnectAttemptError } from '../ssh/ssh-connect-attempt-cancellation'
import { forceStopRelayForTarget } from '../ssh/ssh-relay-reset'
import { isSshPtyNotFoundError } from '../providers/ssh-pty-errors'
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
import {
  initializeSshConnectionGenerationSession,
  resetSshConnectionGenerations
} from '../ssh/ssh-connection-generation'
import {
  getSshProviderAuthority,
  isCurrentSshProviderAuthority,
  resetSshProviderAuthorities,
  rotateSshProviderAuthority
} from '../ssh/ssh-provider-authority'

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
  'ssh:listConfigHosts',
  'ssh:resolveConfigHost',
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
  invalidateConnectAttempt(targetId)
  await runTargetLifecycle(targetId, () =>
    teardownSshTargetTransport(targetId, (session) => session.detachAndPersist())
  )
}

export async function removeRegisteredSshTarget(targetId: string): Promise<void> {
  if (!sshStore) {
    return
  }
  const store = sshStore
  invalidateConnectAttempt(targetId)
  await runTargetLifecycle(targetId, async () => {
    try {
      // Why: removal is destructive; dispose so remote PTYs cannot reattach to a deleted target.
      await teardownSshTargetTransport(targetId, (session) => session.disposeAndPersist())
    } catch (err) {
      // Why: a failed disconnect must not block metadata removal, else the target lingers in the store with uncleaned leases.
      console.warn(
        `[ssh] Failed to disconnect removed target ${targetId}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    persistedStore?.removeSshRemotePtyLeases(targetId)
    store.removeTarget(targetId)
  })
}

// One session per SSH target owns the whole relay lifecycle (mux, providers, abort controller, state machine).
const activeSessions = new Map<string, SshRelaySession>()
const targetLifecycleInFlight = new Map<string, Promise<void>>()

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

export async function requestActiveSshAiVaultSessionList(
  targetId: string,
  params: SshAiVaultRelayListParams,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<unknown> {
  if (isRuntimeOwnedSshTargetId(targetId)) {
    return null
  }
  const session = activeSessions.get(targetId)
  if (!session) {
    throw new Error('SSH relay is not ready')
  }
  return session.requestAiVaultSessionList(params, options)
}

export async function requestActiveSshAiVaultSessionTitles(
  targetId: string,
  params: SshAiVaultRelayTitleParams,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<unknown> {
  if (isRuntimeOwnedSshTargetId(targetId)) {
    return null
  }
  const session = activeSessions.get(targetId)
  if (!session) {
    throw new Error('SSH relay is not ready')
  }
  return session.requestAiVaultSessionTitles(params, options)
}

function runTargetLifecycle(targetId: string, operation: () => Promise<void>): Promise<void> {
  const prior = targetLifecycleInFlight.get(targetId)
  const operationPromise = (async () => {
    if (prior) {
      await prior.catch(() => undefined)
    }
    await operation()
  })()
  let trackedPromise!: Promise<void>
  trackedPromise = operationPromise.finally(() => {
    if (targetLifecycleInFlight.get(targetId) === trackedPromise) {
      targetLifecycleInFlight.delete(targetId)
    }
  })
  targetLifecycleInFlight.set(targetId, trackedPromise)
  return trackedPromise
}

async function awaitTargetLifecycle(targetId: string): Promise<void> {
  while (true) {
    const lifecycle = targetLifecycleInFlight.get(targetId)
    if (!lifecycle) {
      return
    }
    await lifecycle.catch(() => undefined)
  }
}

async function teardownSshTargetTransport(
  targetId: string,
  teardown: (session: SshRelaySession) => void | Promise<void>
): Promise<void> {
  let transportDisconnect: Promise<{ ok: true } | { ok: false; error: unknown }>
  try {
    transportDisconnect = Promise.resolve(connectionManager?.disconnect(targetId)).then(
      () => ({ ok: true }) as const,
      (error: unknown) => ({ ok: false, error }) as const
    )
  } catch (error) {
    transportDisconnect = Promise.resolve({ ok: false, error })
  }
  const sessionTeardown = teardownActiveSshSession(targetId, teardown).then(
    () => ({ ok: true }) as const,
    (error: unknown) => ({ ok: false, error }) as const
  )
  const [disconnectResult, teardownResult] = await Promise.all([
    transportDisconnect,
    sessionTeardown
  ])
  if (!teardownResult.ok) {
    throw teardownResult.error
  }
  if (!disconnectResult.ok) {
    throw disconnectResult.error
  }
}

async function teardownActiveSshSession(
  targetId: string,
  teardown: (session: SshRelaySession) => void | Promise<void>
): Promise<void> {
  const session = activeSessions.get(targetId)
  if (!session) {
    return
  }
  let teardownError: { error: unknown } | null = null
  try {
    // Why: await port teardown so local listeners are released before disconnect/remove completes, else an immediate reconnect hits EADDRINUSE.
    await portForwardManager?.removeAllForwards(targetId)
  } catch (error) {
    teardownError = { error }
  }
  try {
    await teardown(session)
  } catch (error) {
    teardownError ??= { error }
  }
  if (activeSessions.get(targetId) === session) {
    activeSessions.delete(targetId)
    clearRelayLostBackoff(targetId)
    clearRelayStateOverride(targetId)
  }
  if (teardownError) {
    throw teardownError.error
  }
}

// Why: a dropped session must detach, not just leave activeSessions — detach releases the SSH PTY
// consumer identity so the next connect reclaims its owner lease instead of minting a new one.
// Why awaited, and why the map entry outlives the await: a retry can start the moment this returns,
// so it must either find the session (and await this same latched teardown at the existing-session
// path) or find nothing because the 'detached' lease write is already durable. Deleting first lets a
// fast reconnect mark leases 'attached' and then have this session's late 'detached' write clobber it.
async function abandonFailedSshSession(targetId: string, session: SshRelaySession): Promise<void> {
  // Why: detachAndPersist transitions recovery ownership synchronously; only durability is awaited.
  try {
    await session.detachAndPersist()
  } catch (error) {
    // Why: a teardown throw must not mask the connect error the caller is about to rethrow.
    console.warn(
      `[ssh] Failed to detach abandoned session for ${targetId}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (activeSessions.get(targetId) === session) {
    activeSessions.delete(targetId)
  }
}

// Why: a connect cancelled after its transport already opened still owns that transport and its
// unpublished session — nothing else will reach them, so it has to close them itself. Why only the
// connection it minted, and by identity: disconnecting by target id (or closing a transport it merely
// reused) would tear down the replacement connect's live transport.
async function abandonCancelledConnectAttempt(
  targetId: string,
  session: SshRelaySession,
  mintedConnection: SshConnection | null
): Promise<void> {
  // Why the identity guard: every path that removes a session from activeSessions detaches it first,
  // so re-detaching a superseded session would only clobber the replacement's lease state.
  if (activeSessions.get(targetId) === session) {
    await abandonFailedSshSession(targetId, session)
  }
  if (!mintedConnection) {
    return
  }
  try {
    await connectionManager!.disconnectConnection(targetId, mintedConnection)
  } catch (error) {
    // Why: the caller is about to throw the cancellation; a teardown throw must not replace it.
    console.warn(
      `[ssh] Failed to disconnect cancelled connect transport for ${targetId}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function relayGracePeriodForTarget(target: SshTarget | null | undefined): number | undefined {
  return target?.relayGracePeriodSeconds
}

// Why: tabs must share one connect, while a disconnect must invalidate that
// attempt so its late continuation cannot clobber a replacement.
type ConnectAttempt = {
  authority: DirectSshAuthority
  promise: Promise<SshConnectionState>
}

const connectInFlight = new Map<string, ConnectAttempt>()
const pendingTransportReconnects = new Set<string>()

// Why the quit gate rather than a local latch: "the committed quit has begun" already has an owner,
// and a private copy could be set by something that is not actually quitting — leaving SSH connects
// refused for the rest of the process lifetime.
function assertSshConnectsNotFenced(): void {
  if (quitTeardownStartGate.hasStarted()) {
    throw new Error('SSH connects are closed for app shutdown')
  }
}

function invalidateConnectAttempt(targetId: string): void {
  rotateSshProviderAuthority(targetId)
  pendingTransportReconnects.delete(targetId)
  connectInFlight.delete(targetId)
  credentialRequestedForTarget.delete(targetId)
}

function isCurrentConnectAttempt(targetId: string, authority: DirectSshAuthority): boolean {
  return authority.targetId === targetId && isCurrentSshProviderAuthority(authority)
}

// Why: publish reset's teardown/force-stop/disconnect lifecycle so new connects and duplicate resets can't race it.
const resetRelayInFlight = new Map<string, Promise<void>>()

// Why: ssh:testConnection connects then disconnects; suppressing broadcasts during the test avoids worktree cards flashing connected → disconnected.
const testingTargets = new Set<string>()
const testConnectionProbes = new Set<Promise<unknown>>()

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
// Why: transport states the SSH ladder never leaves on its own — waiting for a relay redeploy past one of these is an unbounded loop.
const TRANSPORT_TERMINAL_STATUSES = new Set<SshConnectionStatus>([
  'disconnected',
  'auth-failed',
  'reconnection-failed',
  'error'
])

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
  const authority = getSshProviderAuthority(targetId)
  return {
    ...state,
    targetId,
    providerEpoch: authority.providerEpoch,
    connectionGeneration: authority.connectionGeneration,
    ...(remotePlatform ? { remotePlatform } : {})
  }
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
      const transportReconnectStarted =
        state.status === 'reconnecting' &&
        (sessionState === 'ready' || sessionState === 'reconnecting') &&
        !pendingTransportReconnects.has(targetId)
      if (transportReconnectStarted) {
        rotateSshProviderAuthority(targetId)
        pendingTransportReconnects.add(targetId)
      } else if (
        state.status === 'disconnected' ||
        state.status === 'auth-failed' ||
        state.status === 'reconnection-failed' ||
        state.status === 'error'
      ) {
        pendingTransportReconnects.delete(targetId)
      }
      const completedTransportReconnect =
        state.status === 'connected' && pendingTransportReconnects.delete(targetId)
      const shouldReconnectRelay =
        session !== undefined &&
        completedTransportReconnect &&
        state.reconnectAttempt === 0 &&
        (sessionState === 'ready' || sessionState === 'reconnecting')
      const relayReconnectAlreadyInFlight =
        !completedTransportReconnect &&
        state.status === 'connected' &&
        sessionState === 'reconnecting' &&
        relayStateOverrides.has(targetId)

      if (shouldReconnectRelay) {
        // Why: this branch redeploys the relay itself over a fresh transport, so any pending relay-lost retry is stale — dropping it also gives the new transport generation a full attempt budget.
        clearRelayLostBackoff(targetId)
        // Why: SSH connects before the relay providers rebuild; keep renderer actions gated until SshRelaySession reaches ready again.
        publishRelayOverride(
          getCurrentMainWindow,
          targetId,
          'reconnecting',
          'Relay channel reconnecting...',
          state.reconnectAttempt
        )
      } else if (relayReconnectAlreadyInFlight) {
        // Why: duplicate connected notifications belong to the same socket generation and must not expose providers before relay recovery finishes.
        return
      } else if (
        state.status === 'connected' &&
        session !== undefined &&
        sessionState !== 'ready' &&
        !completedTransportReconnect &&
        connectInFlight.has(targetId)
      ) {
        // Why: the raw SSH transport reaches 'connected' before the relay session establishes during an
        // explicit connect. Forwarding it makes the renderer treat the host as fully up — it remounts
        // SSH panes (-> window.api.ssh.connect) and fires connected-gated data reads before any provider
        // exists. On a permanent relay-deploy failure that premature 'connected' drives an unbounded
        // reconnect loop. Hold it at 'deploying-relay'; the in-flight doConnect broadcasts the
        // authoritative 'connected' directly (bypassing this callback) after establish() succeeds, or a
        // terminal state on failure. The connectInFlight gate keeps this scoped to a live connect, so a
        // stray raw 'connected' with no follow-up (e.g. a transport blip on a session left 'idle' by a
        // relay version mismatch) is never wedged at 'deploying-relay'.
        clearRelayStateOverride(targetId)
        broadcastSshState(getCurrentMainWindow, targetId, {
          targetId,
          status: 'deploying-relay',
          error: state.error,
          reconnectAttempt: state.reconnectAttempt
        })
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
    if (activeSessions.get(tid)?.getState() !== 'deploying') {
      rotateSshProviderAuthority(tid)
    }
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
    rotateSshProviderAuthority(tid)

    // Why: re-deploying the relay rides the SSH transport, so while the transport is itself down no attempt
    // can succeed. Waiting at the max delay without consuming the budget keeps a flapping host off the
    // manual-reconnect banner, which would tell the user to act on a link that is still auto-recovering.
    const transportStatus = connectionManager?.getState(tid)?.status
    const transportConnected = transportStatus === 'connected'
    if (transportConnected && state.attempts >= RELAY_LOST_MAX_ATTEMPTS) {
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

    const scheduleRelayRedeploy = (delay: number, attemptCharged: boolean): void => {
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null
        relayLostBackoff.set(tid, state)
        const liveConn = connectionManager?.getConnection(tid)
        if (!liveConn || !activeSessions.has(tid)) {
          clearRelayLostBackoff(tid)
          return
        }
        const status = connectionManager?.getState(tid)?.status
        if (status === 'connected') {
          if (!attemptCharged) {
            // Why: waiting is free, but the deploy it defers is real — charge it here so a transport that
            // flaps back to 'connected' can't redeploy forever on an uncharged budget.
            state.attempts += 1
          }
          void s.reconnect(liveConn, relayGracePeriodForTarget(t))
          return
        }
        if (status === undefined || TRANSPORT_TERMINAL_STATUSES.has(status)) {
          // Why: the transport gave up for good; its own state is what the user acts on, so stop waiting for a redeploy that can never run.
          clearRelayLostBackoff(tid)
          return
        }
        // Why: still mid-transition — re-arm at the max delay without consuming an attempt. It ends once
        // the transport settles: 'connected' redeploys, a terminal status or a dropped session clears above.
        scheduleRelayRedeploy(RELAY_LOST_MAX_DELAY_MS, false)
      }, delay)
      relayLostBackoff.set(tid, state)
    }

    if (!transportConnected) {
      publishRelayOverride(
        getCurrentMainWindow,
        tid,
        'reconnecting',
        'Relay channel lost. Reconnecting...',
        state.attempts
      )
      scheduleRelayRedeploy(RELAY_LOST_MAX_DELAY_MS, false)
      console.warn(
        `[ssh] Relay channel for ${tid} lost while the SSH transport is ${transportStatus ?? 'unknown'}; waiting ${RELAY_LOST_MAX_DELAY_MS}ms without consuming an attempt`
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
    scheduleRelayRedeploy(delay, true)
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
    currentRuntime?.notifySshRelayReady?.(tid)
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
  initializeSshConnectionGenerationSession()
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
    for (const targetId of new Set(
      repoReadoptions.flatMap(({ oldTargetId, newTargetId }) => [oldTargetId, newTargetId])
    )) {
      rotateSshProviderAuthority(targetId)
    }
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

  // Why: add-host dialog picks one config entry to prefill the form; does not
  // mutate the target store (bulk sync stays on Settings → Import).
  ipcMain.handle('ssh:listConfigHosts', (_event, args?: SshConfigHostListArgs) => {
    return listUserSshConfigHostSummaries(
      sshStore!.listTargets(),
      args?.query,
      sshStore!.listSuppressedSshConfigAliases(),
      { refresh: args?.refresh === true }
    )
  })

  ipcMain.handle('ssh:resolveConfigHost', (_event, args: { alias: string }) => {
    return resolveUserSshConfigHost(args.alias)
  })

  // ── Connection lifecycle ───────────────────────────────────────────

  async function connectTarget(targetId: string): Promise<SshConnectionState> {
    const e2eProbePath = process.env.ORCA_E2E_FORBID_LOCAL_SSH_CONNECT_PROBE
    if (e2eProbePath) {
      appendFileSync(e2eProbePath, `${JSON.stringify(targetId)}\n`)
      throw new Error('e2e_forbidden_local_ssh_connect')
    }
    // Why: fence callers that entered before a same-turn disconnect/reset but resume after its cleanup.
    const admissionAuthority = getSshProviderAuthority(targetId)
    await awaitTargetLifecycle(targetId)
    const reset = resetRelayInFlight.get(targetId)
    if (reset) {
      await reset
    }

    // Why: serialize concurrent ssh:connect for the same target; interleaved connects otherwise leak the first session.
    const existing = connectInFlight.get(targetId)
    let replacePendingTransport = false
    if (existing) {
      if (isCurrentConnectAttempt(targetId, existing.authority)) {
        return existing.promise
      }
    }
    if (!isCurrentConnectAttempt(targetId, admissionAuthority)) {
      throw createCancelledConnectAttemptError()
    }
    const observedAuthority = admissionAuthority
    if (existing) {
      if (connectInFlight.get(targetId) === existing) {
        connectInFlight.delete(targetId)
        replacePendingTransport = true
      }
    }
    if (!isCurrentSshProviderAuthority(observedAuthority)) {
      throw createCancelledConnectAttemptError()
    }
    // Why: the shutdown drain fences and snapshots synchronously, so a connect either registers in
    // connectInFlight below (and gets joined) or fails here — it can never slip between the two.
    assertSshConnectsNotFenced()

    pendingTransportReconnects.delete(targetId)
    const promise = doConnect(targetId, replacePendingTransport)
    const attempt = { authority: getSshProviderAuthority(targetId), promise }
    connectInFlight.set(targetId, attempt)
    try {
      return await promise
    } finally {
      if (connectInFlight.get(targetId) === attempt) {
        connectInFlight.delete(targetId)
      }
    }
  }

  registeredConnectSshTarget = connectTarget
  registeredGetSshState = (targetId: string) => getPublicSshState(targetId)

  ipcMain.handle('ssh:connect', async (_event, args: { targetId: string }) => {
    return connectTarget(args.targetId)
  })

  async function doConnect(
    targetId: string,
    replacePendingTransport = false
  ): Promise<SshConnectionState> {
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
      return getPublicSshState(targetId)!
    }

    const authority = rotateSshProviderAuthority(targetId)
    clearRelayStateOverride(targetId)
    const pendingTransportDisconnect = replacePendingTransport
      ? connectionManager!.disconnect(targetId).then(
          () => ({ ok: true }) as const,
          (error: unknown) => ({ ok: false, error }) as const
        )
      : null
    let conn
    // Why: tear down any existing session first to avoid leaking its multiplexer, providers, and timers (double-connect / reconnect-after-error).
    if (existingSession) {
      // Why: await port teardown before disposing, else the new session's restorePortForwards can hit EADDRINUSE on not-yet-released ports.
      await portForwardManager!.removeAllForwards(targetId)
      if (!isCurrentConnectAttempt(targetId, authority)) {
        throw createCancelledConnectAttemptError()
      }
      try {
        await existingSession.detachAndPersist()
      } finally {
        // Why finally: detachAndPersist runs its in-memory half synchronously, so the session is
        // dead even when the lease write rejects — keeping it in activeSessions would strand every
        // later connect on the same dead session. Why still after the await, not before it: the
        // write has settled by now, so it can no longer clobber the replacement's 'attached' write.
        if (activeSessions.get(targetId) === existingSession) {
          activeSessions.delete(targetId)
          clearRelayLostBackoff(targetId)
          clearRelayStateOverride(targetId)
        }
      }
    }

    if (pendingTransportDisconnect) {
      const disconnectResult = await pendingTransportDisconnect
      if (!disconnectResult.ok) {
        throw disconnectResult.error
      }
      if (!isCurrentConnectAttempt(targetId, authority)) {
        throw createCancelledConnectAttemptError()
      }
    }

    // Why here and not only at entry: this is the publication point, and it is the last statement
    // before the transport opens. Checking it in the same synchronous block as activeSessions.set
    // means a connect either registers before the shutdown drain snapshots, or registers never and
    // owns nothing to clean up.
    assertSshConnectsNotFenced()
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
    const ownsSession = (): boolean =>
      isCurrentConnectAttempt(targetId, authority) && activeSessions.get(targetId) === session

    // Why captured here and not with existingState: connect() reuses an already-connected transport,
    // and only a transport this attempt opened is this attempt's to close when it loses the race.
    const priorConnection = connectionManager!.getConnection(targetId)
    const mintedConnection = (): SshConnection | null =>
      conn && conn !== priorConnection ? conn : null

    try {
      conn = await connectionManager!.connect(target)
      if (!ownsSession()) {
        throw createCancelledConnectAttemptError()
      }
    } catch (err) {
      // Why: connect()'s internal state may not have reached the renderer; broadcast explicitly so the UI leaves 'connecting'.
      const errObj = err instanceof Error ? err : new Error(String(err))
      const status: SshConnectionStatus = isAuthError(errObj) ? 'auth-failed' : 'error'
      if (!ownsSession()) {
        await abandonCancelledConnectAttempt(targetId, session, mintedConnection())
        throw createCancelledConnectAttemptError()
      }
      // Why: clear this failed connect's flag so a later non-prompting connect isn't deferred.
      credentialRequestedForTarget.delete(targetId)
      await abandonFailedSshSession(targetId, session)
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
      if (!ownsSession()) {
        throw createCancelledConnectAttemptError()
      }

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
      if (!ownsSession()) {
        await abandonCancelledConnectAttempt(targetId, session, mintedConnection())
        throw createCancelledConnectAttemptError()
      }
      await abandonFailedSshSession(targetId, session)
      clearRelayLostBackoff(targetId)
      try {
        await connectionManager!.disconnect(targetId)
      } catch (disconnectError) {
        // Why: the establish failure is the actionable error; a teardown throw must not replace it.
        console.warn(
          `[ssh] Failed to disconnect transport after failed establish for ${targetId}: ${disconnectError instanceof Error ? disconnectError.message : String(disconnectError)}`
        )
      }
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
    invalidateConnectAttempt(args.targetId)
    await runTargetLifecycle(args.targetId, async () => {
      const provider = getSshPtyProvider(args.targetId)
      const leases = persistedStore!.getSshRemotePtyLeases(args.targetId)
      const ptyIdsByRelayId = new Map<string, string>()
      // Why: only leases the app still believes it owns may force a reconnect; 'expired' ones are
      // swept opportunistically because they can name a host that is gone for good (issue #2626).
      const ownedRelayIds = new Set<string>()
      const trackPtyId = (ptyId: string, owned: boolean): void => {
        const relayPtyId = toRelaySshPtyId(args.targetId, ptyId)
        if (!ptyIdsByRelayId.has(relayPtyId)) {
          ptyIdsByRelayId.set(relayPtyId, toAppSshPtyId(args.targetId, ptyId))
        }
        if (owned) {
          ownedRelayIds.add(relayPtyId)
        }
      }
      for (const ptyId of getPtyIdsForConnection(args.targetId)) {
        trackPtyId(ptyId, true)
      }
      for (const lease of leases) {
        if (lease.state === 'terminated') {
          continue
        }
        // Why: 'expired' records that reattach gave up, never that the remote shell died — those are
        // precisely the orphans, so the user's terminate action has to be able to reach them.
        trackPtyId(lease.ptyId, lease.state !== 'expired')
      }
      const ptyIds = Array.from(ptyIdsByRelayId, ([relayPtyId, appPtyId]) => ({
        relayPtyId,
        appPtyId
      }))

      if (ownedRelayIds.size > 0 && !provider) {
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
      await teardownSshTargetTransport(args.targetId, (session) => session.disposeAndPersist())
    })
  })

  async function doResetRelay(targetId: string, target: SshTarget): Promise<void> {
    const inFlightConnect = connectInFlight.get(targetId)
    if (inFlightConnect) {
      try {
        // Why: resetting activeSessions mid-deploy would dispose the session doConnect will use.
        await inFlightConnect.promise
      } catch {
        // The reset can still recover a stale remote relay after a failed connect.
      }
    }

    rotateSshProviderAuthority(targetId)
    const session = activeSessions.get(targetId)
    if (session) {
      // Why: detach() not dispose() — reset has its own stale-lease semantics below that dispose()'s clean-termination recording would hide.
      await teardownActiveSshSession(targetId, (capturedSession) =>
        capturedSession.detachAndPersist()
      )
    }

    const existingConn = connectionManager!.getConnection(targetId)
    let conn = existingConn
    if (!conn) {
      // Why re-check: admission fenced this reset before it parked on the in-flight connect, so shutdown
      // may have started (and drained) while we waited — opening a transport now would outlive the drain.
      assertSshConnectsNotFenced()
      conn = await connectionManager!.connect(target)
    }
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
    // Why: reset opens its own transport, so it must be fenced by shutdown the same way connect is.
    assertSshConnectsNotFenced()

    let resetPromise: Promise<void>
    resetPromise = runTargetLifecycle(args.targetId, () =>
      doResetRelay(args.targetId, target)
    ).finally(() => {
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
        const state = await inFlight.promise
        return { success: true, state }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }

    testingTargets.add(args.targetId)
    // Why a tracked promise and not just the id: a probe holds a real transport that no session owns,
    // so shutdown has to be able to join it before the final drain disconnects what is left.
    const probe = (async () => {
      // Why: a probe transport opened after the shutdown drain would outlive orderly teardown.
      assertSshConnectsNotFenced()
      const conn = await connectionManager!.connect(target)
      const state = conn.getState()
      await connectionManager!.disconnect(args.targetId)
      return state
    })()
    testConnectionProbes.add(probe)
    try {
      return { success: true, state: await probe }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err)
      }
    } finally {
      testConnectionProbes.delete(probe)
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

// Why one budget for the whole sequence rather than one per phase: an invalidated connect only
// observes its cancellation at the next checkpoint, and one blocked in the transport handshake can
// sit there for the whole SSH timeout. A per-phase timeout lets any single phase consume the global
// quit deadline; a shared absolute deadline cannot.
export const SSH_SHUTDOWN_BUDGET_MS = 6_000

export type SshShutdownPhase = 'drain' | 'in-flight-join' | 'final-drain'
export type SshShutdownUnfinished = { targetId: string; phase: SshShutdownPhase }
export type SshShutdownResult = {
  unfinished: readonly SshShutdownUnfinished[]
  errors: readonly unknown[]
}

type SshShutdownTask = { targetId: string; promise: Promise<unknown> }

let sshShutdownDrain: Promise<SshShutdownResult> | null = null

async function settleTasksWithinMs(
  tasks: readonly SshShutdownTask[],
  timeoutMs: number
): Promise<{ timedOut: SshShutdownTask[]; errors: unknown[] }> {
  const pending = new Set(tasks)
  const errors: unknown[] = []
  if (tasks.length === 0) {
    return { timedOut: [], errors }
  }
  const tracked = tasks.map(async (task) => {
    try {
      await task.promise
    } catch (error) {
      errors.push(error)
    }
    pending.delete(task)
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all(tracked),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      })
    ])
  } finally {
    clearTimeout(timer)
  }
  return { timedOut: [...pending], errors }
}

function sshShutdownTasks(targetIds: readonly string[]): SshShutdownTask[] {
  return [
    ...targetIds
      .filter((targetId) => activeSessions.has(targetId))
      .map((targetId) => ({
        targetId,
        promise: teardownActiveSshSession(targetId, (session) => session.detachAndPersist())
      })),
    { targetId: '*transports', promise: connectionManager?.disconnectAll() ?? Promise.resolve() }
  ]
}

async function drainSshShutdown(
  targetIds: readonly string[],
  inFlight: readonly SshShutdownTask[],
  detachErrors: readonly unknown[] = []
): Promise<SshShutdownResult> {
  const deadline = Date.now() + SSH_SHUTDOWN_BUDGET_MS
  const unfinished: SshShutdownUnfinished[] = []
  const errors: unknown[] = [...detachErrors]
  const runPhase = async (
    phase: SshShutdownPhase,
    tasks: readonly SshShutdownTask[]
  ): Promise<boolean> => {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      unfinished.push(...tasks.map((task) => ({ targetId: task.targetId, phase })))
      return false
    }
    const settled = await settleTasksWithinMs(tasks, remainingMs)
    errors.push(...settled.errors)
    unfinished.push(...settled.timedOut.map((task) => ({ targetId: task.targetId, phase })))
    return settled.timedOut.length === 0
  }

  await runPhase('drain', sshShutdownTasks(targetIds))
  // Why a second drain after the join: a connect paused in old-session teardown still publishes its
  // replacement session and opens a transport before it reaches the cancellation checkpoint, so the
  // first drain can miss both.
  if (await runPhase('in-flight-join', inFlight)) {
    await runPhase('final-drain', sshShutdownTasks([...activeSessions.keys()]))
  }

  if (errors.length > 0 || unfinished.length > 0) {
    // Why one aggregate line: per-target logging on the quit path competes with the final flush for
    // the little time that remains.
    console.warn(
      `[ssh] Shutdown drain finished with ${errors.length} error(s); unfinished: ${
        unfinished.map((entry) => `${entry.targetId}/${entry.phase}`).join(', ') || 'none'
      }`
    )
  }
  return { unfinished, errors }
}

// Why one entry point that returns rather than awaits: every in-memory transition the final store
// flush must snapshot happens synchronously here, before this returns, so the caller can start that
// flush with no await in between. Idempotent — a later call joins the same drain and repeats no
// state transition.
//
// Why no fence latch here: the committed quit path sets it before calling this, so it is already on
// for the snapshot below. Called without that gate (tests), this degrades to a plain drain.
export function beginSshShutdown(): Promise<SshShutdownResult> {
  if (sshShutdownDrain) {
    return sshShutdownDrain
  }
  const inFlight: SshShutdownTask[] = [
    ...[...connectInFlight.entries()].map(([targetId, attempt]) => ({
      targetId,
      promise: attempt.promise
    })),
    ...[...resetRelayInFlight.entries()].map(([targetId, promise]) => ({ targetId, promise })),
    ...[...testConnectionProbes].map((promise) => ({ targetId: '*probe', promise }))
  ]
  for (const targetId of Array.from(connectInFlight.keys())) {
    invalidateConnectAttempt(targetId)
  }
  const targetIds = [...activeSessions.keys()]
  // Why before any await: this is the whole point of the split. Each session marks its recovery lease
  // detached in memory now, and the final flush persists it — the remote PTYs keep running.
  const detachErrors: unknown[] = []
  for (const session of activeSessions.values()) {
    // Why per-session: this runs synchronously inside a non-async will-quit listener, so one throw
    // (teardownProviders -> webContents.send on a destroyed renderer, routine on quit) would escape
    // it and skip every later session, the drain assignment, and the store flush that persists all
    // of this. Collect and keep going; the drain reports them.
    try {
      session.beginShutdownDetach()
    } catch (error) {
      detachErrors.push(error)
    }
  }
  sshShutdownDrain = drainSshShutdown(targetIds, inFlight, detachErrors)
  return sshShutdownDrain
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

  // Why: allSettled — a rejected disposal write must not abort the rest of the reset and leak state into the next test.
  await Promise.allSettled(
    [...activeSessions.values()].map((session) => session.disposeAndPersist())
  )
  activeSessions.clear()
  for (const targetId of relayLostBackoff.keys()) {
    clearRelayLostBackoff(targetId)
  }
  relayStateOverrides.clear()
  connectInFlight.clear()
  targetLifecycleInFlight.clear()
  pendingTransportReconnects.clear()
  resetSshConnectionGenerations()
  resetSshProviderAuthorities()
  resetRelayInFlight.clear()
  testingTargets.clear()
  testConnectionProbes.clear()
  credentialRequestedForTarget.clear()
  quitTeardownStartGate.resetForTests()
  sshShutdownDrain = null

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
