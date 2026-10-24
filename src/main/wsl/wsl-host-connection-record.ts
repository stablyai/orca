/** What a WSL host's connection change writes to its records, and how the UI sees its status. */
import { refreshWslHostPairing } from '../../shared/runtime-environment-wsl-host-store'
import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import type { WslHostStatus } from '../../shared/wsl-host-types'
import type { WslOrcadConnection } from './wsl-orcad-connection'
import type { WslOrcadConnectionStatus } from './wsl-orcad-connection-status'

/** Saves an explicit re-pair or a moved bridge; true when the pairing changed. */
export function persistWslHostConnection(
  userDataPath: string,
  record: WslHostDeploymentRecord,
  connection: WslOrcadConnection
): boolean {
  try {
    return refreshWslHostPairing(userDataPath, record.environmentId, {
      pairingCode: connection.pairingOffer,
      localPort: connection.localPort,
      remotePort: connection.remotePort
    }).pairingChanged
  } catch (error) {
    console.warn(`[wsl-hosts] Could not save the new pairing for ${record.distro}:`, error)
    return false
  }
}

export function toWslHostStatus(
  record: WslHostDeploymentRecord,
  status: WslOrcadConnectionStatus,
  connection: WslOrcadConnection | null = null
): WslHostStatus {
  return {
    environmentId: record.environmentId,
    distro: record.distro,
    state: status.state,
    detail: status.state === 'failed' || status.state === 'unverifiable' ? status.reason : null,
    // A ready host serves the incumbent the deferral describes; a deferred connect serves nothing,
    // and its deferral is what offers Update or Force.
    deferredUpdate:
      status.state === 'ready'
        ? (connection?.deferredUpdate ?? null)
        : status.state === 'failed'
          ? (status.deferredUpdate ?? null)
          : null
  }
}
