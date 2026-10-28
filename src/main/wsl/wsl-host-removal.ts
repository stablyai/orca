/**
 * Removing a WSL host (E11). Only a proven stop drops its records; anything else keeps the host
 * listed with a pending stop, so the next Remove retries it and Connect or Add can keep the host.
 * Dropping it would strand a still-running server that blocks the next add's activation.
 */
import { errorMessage } from '../../shared/error-message'
import {
  removeWslHostEnvironment,
  setWslHostPendingStop
} from '../../shared/runtime-environment-wsl-host-store'
import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import type { WslHostAddResult, WslHostServerStop } from '../../shared/wsl-host-types'
import { admitWslHostDistro, wslHostRemovalPendingMessage } from './wsl-host-add-admission'
import type { WslHostDistroCandidate } from './wsl-host-distro-list'
import type { WslHostConnector } from './wsl-host-service'
import { noteWslHostUserAction } from './wsl-host-user-actions'

export type WslHostRemoval = { serverStop: WslHostServerStop; removed: boolean }

export async function removeWslHostServer(
  userDataPath: string,
  connector: WslHostConnector | null,
  record: WslHostDeploymentRecord
): Promise<WslHostRemoval> {
  let serverStop: WslHostServerStop = { stopped: true }
  if (connector) {
    // A distro that is no longer registered (by GUID or name) runs nothing of this host.
    const current = await connector
      .resolveDistroName(record.distro, record.distroId)
      .catch(() => null)
    if (current !== false) {
      // Under its current name: a renamed distro never reads as running under the old one.
      // Never boots: a stopped distro is itself a proven stop.
      serverStop = await connector
        .stopServer(current ?? record.distro, record.environmentId)
        .catch((error: unknown): WslHostServerStop => ({
          stopped: false,
          verdict: 'unverifiable',
          reason: errorMessage(error)
        }))
    }
    await connector.disconnect(record.distro)
    // Without its holder the distro idles out, pending or not.
    await connector.releaseHolder(record.distro)
  }
  if (serverStop.stopped) {
    removeWslHostEnvironment(userDataPath, record.environmentId)
    // Every Remove (sidebar or Settings) is the user's: the move orchestrator never removes a
    // host. Only on the proven stop, and before the service's cleanup await can fail.
    noteWslHostUserAction({ kind: 'removed', distro: record.distro })
    return { serverStop, removed: true }
  }
  setWslHostPendingStop(userDataPath, record.environmentId, {
    since: Date.now(),
    reason: serverStop.reason,
    verdict: serverStop.verdict ?? 'unverifiable'
  })
  return { serverStop: { ...serverStop, kept: true }, removed: false }
}

/** Adding a pending host again keeps it, under the same stopped-distro rule as any add. */
export async function readdPendingWslHost(
  args: { distro: string; startIfStopped?: boolean },
  host: {
    listDistros: () => Promise<WslHostDistroCandidate[]>
    keep: () => Promise<void>
    environmentId: string
  }
): Promise<WslHostAddResult> {
  try {
    const admission = admitWslHostDistro({
      requested: args.distro,
      candidates: await host.listDistros(),
      alreadyAdded: () => false,
      startIfStopped: args.startIfStopped === true
    })
    if (!('distro' in admission)) {
      return admission
    }
    await host.keep()
    return { ok: true, environmentId: host.environmentId }
  } catch (error) {
    return { ok: false, kind: 'failed', message: errorMessage(error) }
  }
}

/** A pending host connects only for the user's own Connect or Add, which withdraws its Remove. */
export function admitConnectToPendingHost(
  userDataPath: string,
  record: WslHostDeploymentRecord,
  withdraw: boolean
): void {
  if (!record.pendingStop) {
    return
  }
  if (!withdraw) {
    throw new Error(wslHostRemovalPendingMessage(record.distro))
  }
  setWslHostPendingStop(userDataPath, record.environmentId, null)
}
