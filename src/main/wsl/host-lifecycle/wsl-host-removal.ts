/** Removing a WSL host (E11): a proven stop drops it, else it stays pending; a repeat Remove of an unreachable server drops it anyway (#49180). */
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
import { stopAsHostAccount } from './wsl-host-account-migration'
import { isWslHostKeyChangedRefusal } from '../../managed-server/lifecycle/orcad-managed-tunnel-identity'

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
      const name = current ?? record.distro
      const stop = () => connector.stopServer(name, record.environmentId)
      serverStop = await stopAsHostAccount(userDataPath, record, name, stop).catch(
        (error: unknown): WslHostServerStop =>
          // The pinned account's server holds another key, so the paired one no longer runs: one Remove.
          isWslHostKeyChangedRefusal(error)
            ? {
                stopped: false,
                verdict: 'unverifiable',
                ...wslHostServerStopReason('serverIdentityReset'),
                forgotten: true
              }
            : { stopped: false, verdict: 'unverifiable', reason: errorMessage(error) }
      )
    }
    await connector.disconnect(record.distro)
    // Without its holder the distro stops once nothing started in it (a peer's orcad, user jobs) runs.
    await connector.releaseHolder(record.distro)
  }
  serverStop = noteServerKeptForPeers(userDataPath, record.environmentId, serverStop)
  if (!serverStop.stopped && (forget || (record.pendingStop && mayForgetOnRetry(serverStop)))) {
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

/** A repeated Remove drops the host only when Orca couldn't reach it, never past proven live work. */
function mayForgetOnRetry(serverStop: Extract<WslHostServerStop, { stopped: false }>): boolean {
  return serverStop.verdict !== 'live' && serverStop.reasonCode !== 'removalUnrecorded'
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
