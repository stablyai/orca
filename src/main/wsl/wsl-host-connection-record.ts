/** What a WSL host's connection change writes to its records, and how the UI sees its status. */
import {
  backfillWslHostDistroId,
  refreshWslHostPairing
} from '../../shared/runtime-environment-wsl-host-store'
import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import type { WslHostStatus } from '../../shared/wsl-host-types'
import { readWslDistroRegistryIdShared } from './wsl-distro-registry-id'
import type { WslOrcadConnection } from './wsl-orcad-connection'
import type { WslOrcadConnectionStatus } from './wsl-orcad-connection-status'

/** Saves a relaunch's new device token or a moved bridge; true when the pairing changed. */
export function persistWslHostConnection(
  userDataPath: string,
  record: WslHostDeploymentRecord,
  connection: WslOrcadConnection
): boolean {
  // Why fire-and-forget: a reg.exe read must not delay saving the pairing.
  void backfillWslHostRegistration(userDataPath, record)
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

/**
 * Fills the registration GUID of a host added before it was captured, which lets its browser
 * logins survive orcad relaunches. An unreadable registry leaves it absent, so identity fails closed.
 */
export async function backfillWslHostRegistration(
  userDataPath: string,
  record: WslHostDeploymentRecord,
  readRegistryId: (distro: string) => Promise<string | null> = readWslDistroRegistryIdShared
): Promise<boolean> {
  if (record.distroId) {
    return false
  }
  try {
    const distroId = await readRegistryId(record.distro)
    return (
      distroId !== null &&
      backfillWslHostDistroId(userDataPath, record.environmentId, {
        distro: record.distro,
        distroId
      })
    )
  } catch (error) {
    console.warn(`[wsl-hosts] Could not record the registration of ${record.distro}:`, error)
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
    // Only a ready host is serving the incumbent the deferral describes.
    deferredUpdate: status.state === 'ready' ? (connection?.deferredUpdate ?? null) : null
  }
}
