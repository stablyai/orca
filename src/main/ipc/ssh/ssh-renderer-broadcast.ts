import type { BrowserWindow } from 'electron'
import type { SshPortForwardManager } from '../../ssh/port-forwarding/ssh-port-forward'
import type {
  DetectedPort,
  EnrichedDetectedPort,
  SshConnectionState
} from '../../../shared/ssh-types'
import { isOwnedSshTargetId } from '../../../shared/execution-host'
import {
  enrichSshDetectedPorts,
  enrichSshForwardEntries,
  getWorktreeIdsForConnection
} from '../../ports/ssh-advertised-url-enrichment'
import { isRuntimeOwnedSshTarget } from '../../ssh/connection/ssh-connection-store'
import { getSshProviderAuthority } from '../../ssh/ssh-provider-authority'
import { clearSshHostServerStatus, getSshHostServerStatus } from '../../ssh/ssh-host-server-status'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import {
  connectionManager,
  currentRuntime,
  getCurrentMainWindow,
  persistedStore,
  portForwardManager
} from './ssh-ipc-context'
import { requestDesktopBrowserBridgeReconcile } from '../desktop-browser-bridge-reconcile'

export function broadcastSshState(
  getMainWindow: () => BrowserWindow | null,
  targetId: string,
  state: SshConnectionState
): void {
  const target = getSshTargetRegistryStore()?.getTarget(targetId)
  // Internal targets must not leak transport state into clients' persisted reconnect hints.
  if (isOwnedSshTargetId(targetId) || (target && isRuntimeOwnedSshTarget(target))) {
    currentRuntime?.invalidateSshWorktreeScanCache?.(targetId)
    return
  }
  const enrichedState = withSshRemotePlatform(targetId, state)
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('ssh:state-changed', { targetId, state: enrichedState })
  }
  // Paired clients lack local SSH IPC; publish runtime events to clear stale reconnect overlays.
  currentRuntime?.notifySshStateChanged?.(targetId, enrichedState)
  requestDesktopBrowserBridgeReconcile()
}

function withSshRemotePlatform(targetId: string, state: SshConnectionState): SshConnectionState {
  const authority = getSshProviderAuthority(targetId)
  const managedServer = state.managedServer ?? getSshHostServerStatus(targetId)
  return {
    ...state,
    targetId,
    providerEpoch: authority.providerEpoch,
    connectionGeneration: authority.connectionGeneration,
    ...(managedServer ? { managedServer } : {})
  }
}

/** Unlinking clears managed status and republishes to invalidate cached worktree scans without reconnecting. */
export function clearPublishedManagedServer(targetId: string): void {
  clearSshHostServerStatus(targetId)
  const state = connectionManager?.getState(targetId)
  if (state) {
    broadcastSshState(getCurrentMainWindow, targetId, state)
  }
}

export function getPublicSshState(targetId: string): SshConnectionState | undefined {
  const state = connectionManager!.getState(targetId)
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
