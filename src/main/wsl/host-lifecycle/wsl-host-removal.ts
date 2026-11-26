/**
 * Removing a WSL host (E11). A first Remove drops its records only on a proven stop; anything else
 * keeps the host listed with a pending stop, so Connect or Add can still keep it. Removing it again
 * retries the stop and, if that still can't be proven, drops it anyway (#49180): a host whose
 * server can't be reached (a changed default user, a deleted account) must never be stuck listed.
 */
import { errorMessage } from '../../../shared/errors/error-message'
import { wslHostServerStopReason } from '../../../shared/remote-runtime/wsl-hosts/wsl-host-failure-copy'
import {
  removeWslHostEnvironment,
  setWslHostPendingStop
} from '../../../shared/remote-runtime/host-store/runtime-environment-wsl-host-store'
import type { WslHostDeploymentRecord } from '../../../shared/remote-runtime/host-store/wsl-host-deployment-store'
import type {
  WslHostAddResult,
  WslHostServerStop
} from '../../../shared/remote-runtime/wsl-hosts/wsl-host-types'
import { admitWslHostDistro, wslHostRemovalPendingMessage } from './wsl-host-add-admission'
import type { WslHostDistroCandidate } from './wsl-host-distro-list'
import type { WslHostConnector } from './wsl-host-connector-contract'
import { noteWslHostUserAction } from './wsl-host-user-actions'
import { forgetWslHostKeptForPeers, recordWslHostKeptForPeers } from './wsl-host-kept-for-peers'

export type WslHostRemoval = { serverStop: WslHostServerStop; removed: boolean }

const FORGOTTEN: WslHostServerStop = {
  stopped: false,
  verdict: 'unverifiable',
  reason: 'Orca didn’t contact the distro, so its server may still be running there.',
  forgotten: true
}

export async function removeWslHostServer(
  userDataPath: string,
  connector: WslHostConnector | null,
  record: WslHostDeploymentRecord,
  /** Drop the host without contacting its distro (the CLI's forget). */
  forget = false
): Promise<WslHostRemoval> {
  let serverStop: WslHostServerStop = forget ? FORGOTTEN : { stopped: true }
  if (forget && connector) {
    await connector.disconnect(record.distro)
    await connector.releaseHolder(record.distro)
  } else if (connector) {
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
    // Without its holder the distro stops once nothing started in it (a peer's orcad, user jobs) runs.
    await connector.releaseHolder(record.distro)
  }
  serverStop = noteServerKeptForPeers(userDataPath, record.environmentId, serverStop)
  // The user already saw this stop fail once and asked again: let go of the host regardless.
  if (!serverStop.stopped && (forget || record.pendingStop)) {
    serverStop = { ...serverStop, forgotten: true }
  }
  if (serverStop.stopped || serverStop.forgotten) {
    await removeWslHostEnvironment(userDataPath, record.environmentId)
    // Every Remove (sidebar or Settings) is the user's: the move orchestrator never removes a
    // host. Only once the host is dropped, and before the service's cleanup await can fail.
    noteWslHostUserAction({ kind: 'removed', distro: record.distro })
    return { serverStop, removed: true }
  }
  const { reason, reasonCode, reasonParams } = serverStop
  await setWslHostPendingStop(userDataPath, record.environmentId, {
    since: Date.now(),
    reason,
    ...(reasonCode ? { reasonCode } : {}),
    ...(reasonCode && reasonParams ? { reasonParams } : {}),
    verdict: serverStop.verdict ?? 'unverifiable'
  })
  return { serverStop: { ...serverStop, kept: true }, removed: false }
}

/** R39: undo of a move onto this host must not read a server kept for another Orca as stopped. */
function noteServerKeptForPeers(
  userDataPath: string,
  environmentId: string,
  serverStop: WslHostServerStop
): WslHostServerStop {
  if (!serverStop.stopped) {
    return serverStop
  }
  try {
    if (serverStop.keptForOtherDesktops) {
      recordWslHostKeptForPeers(userDataPath, environmentId)
    } else {
      forgetWslHostKeptForPeers(userDataPath, environmentId)
    }
    return serverStop
  } catch (error) {
    // Unrecorded, a later undo would take the kept server for stopped; keep the host listed instead.
    return {
      stopped: false,
      verdict: serverStop.keptForOtherDesktops ? 'live' : 'unverifiable',
      ...wslHostServerStopReason('removalUnrecorded', { detail: errorMessage(error) })
    }
  }
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
export async function admitConnectToPendingHost(
  userDataPath: string,
  record: WslHostDeploymentRecord,
  withdraw: boolean
): Promise<void> {
  if (!record.pendingStop) {
    return
  }
  if (!withdraw) {
    throw new Error(wslHostRemovalPendingMessage(record.distro))
  }
  await setWslHostPendingStop(userDataPath, record.environmentId, null)
}
