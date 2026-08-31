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
import { getSshProviderAuthority } from '../ssh/ssh-provider-authority'
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
