import type { BrowserWindow } from 'electron'
import type { SshPortForwardManager } from '../ssh/ssh-port-forward'
import type {
  DetectedPort,
  EnrichedDetectedPort,
  SshConnectionStatus,
  SshConnectionState
} from '../../shared/ssh-types'
import { isRuntimeOwnedSshTargetId } from '../../shared/execution-host'
import {
  enrichSshDetectedPorts,
  enrichSshForwardEntries,
  getWorktreeIdsForConnection
} from '../ports/ssh-advertised-url-enrichment'
import { isRuntimeOwnedSshTarget } from '../ssh/ssh-connection-store'
import { getSshProviderAuthority } from '../ssh/ssh-provider-authority'
import { getSshPlainSshMode } from '../ssh/ssh-plain-ssh-mode'
import { isSshRelayOnHostNodeRuntime } from '../ssh/ssh-host-node-runtime-mode'
import { clearSshHostServerStatus, getSshHostServerStatus } from '../ssh/ssh-host-server-status'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { activeSessions } from './ssh-active-relay-sessions'
import {
  connectionManager,
  currentRuntime,
  getCurrentMainWindow,
  persistedStore,
  portForwardManager
} from './ssh-ipc-context'

export const relayStateOverrides = new Map<string, SshConnectionState>()

export function broadcastSshState(
  getMainWindow: () => BrowserWindow | null,
  targetId: string,
  state: SshConnectionState
): void {
  const target = getSshTargetRegistryStore()?.getTarget(targetId)
  // Why: owned targets are hidden from clients; broadcasting them leaks internal transport state into persisted reconnect hints.
  if (isRuntimeOwnedSshTargetId(targetId) || (target && isRuntimeOwnedSshTarget(target))) {
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
  const plainSsh = state.status === 'connected' ? getSshPlainSshMode(targetId) : undefined
  const managedServer = state.managedServer ?? getSshHostServerStatus(targetId)
  // Why the managed check: a host that moved to its managed server no longer runs that relay.
  const hostNodeRuntime =
    state.status === 'connected' &&
    !plainSsh &&
    managedServer?.kind !== 'managed' &&
    isSshRelayOnHostNodeRuntime(targetId)
  return {
    ...state,
    targetId,
    providerEpoch: authority.providerEpoch,
    connectionGeneration: authority.connectionGeneration,
    ...(remotePlatform ? { remotePlatform } : {}),
    ...(plainSsh ? { plainSsh } : {}),
    ...(hostNodeRuntime ? { hostNodeRuntime } : {}),
    ...(managedServer ? { managedServer } : {})
  }
}

export function publishRelayOverride(
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

export function clearRelayStateOverride(targetId: string): void {
  relayStateOverrides.delete(targetId)
}

export function connectionSupportsFolderDownload(targetId: string): boolean {
  // Why: connections without an explicit transport are ssh2-shaped; only a confirmed system-SSH transport lacks the SFTP-only capability.
  return connectionManager?.getConnection(targetId)?.usesSystemSshTransport?.() !== true
}

/**
 * Forgets a host's managed-server decision once its server is unlinked, and republishes the
 * connection without it. The republish is also what drops the host's cached worktree scans, so
 * listings stop naming the removed server without waiting for a reconnect.
 */
export function clearPublishedManagedServer(targetId: string): void {
  clearSshHostServerStatus(targetId)
  const override = relayStateOverrides.get(targetId)
  if (override?.managedServer) {
    const { managedServer: _removed, ...rest } = override
    relayStateOverrides.set(targetId, rest)
  }
  const state = relayStateOverrides.get(targetId) ?? connectionManager?.getState(targetId)
  if (state) {
    broadcastSshState(getCurrentMainWindow, targetId, state)
  }
}

export function getPublicSshState(targetId: string): SshConnectionState | undefined {
  const state = relayStateOverrides.get(targetId) ?? connectionManager!.getState(targetId)
  return state ? withSshRemotePlatform(targetId, state) : undefined
}

export function broadcastPortForwards(
  getMainWindow: () => BrowserWindow | null,
  targetId: string
): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    return
  }
  win.webContents.send('ssh:port-forwards-changed', {
    targetId,
    forwards: listForwardsEnriched(targetId)
  })
}

export function broadcastDetectedPorts(
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

export function enrichDetected(
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

export function broadcastDetectedPortsFromCurrentWindow(
  targetId: string,
  ports: DetectedPort[],
  _platform: string
): void {
  broadcastDetectedPorts(getCurrentMainWindow, targetId, ports)
}
