import { refreshWslHostPairing } from '../../../shared/remote-runtime/host-store/runtime-environment-wsl-host-store'
import type { WslHostDeploymentRecord } from '../../../shared/remote-runtime/host-store/wsl-host-deployment-store'
import { readWslHostDeployments } from '../../../shared/remote-runtime/host-store/runtime-environment-registry'
import {
  wslHostInstallLockWaitText,
  wslHostStatusDetailText,
  type WslHostCopyParams,
  type WslHostStatusDetailCode
} from '../../../shared/remote-runtime/wsl-hosts/wsl-host-failure-copy'
import type {
  WslHostAddProgress,
  WslHostStatus
} from '../../../shared/remote-runtime/wsl-hosts/wsl-host-types'
import type { WslOrcadConnection } from '../orcad/wsl-orcad-connection-types'
import type { WslOrcadConnectionStatus } from '../orcad/wsl-orcad-connection-status'
import type { WslLivenessUnverifiableReason } from '../orcad/wsl-orcad-liveness-verdict'
import { pinWslHostLinuxUsers } from '../orcad/wsl-orcad-host-user'

/** Saves an explicit re-pair or a moved bridge; true when the pairing changed. */
export async function persistWslHostConnection(
  userDataPath: string,
  record: WslHostDeploymentRecord,
  connection: WslOrcadConnection
): Promise<boolean> {
  try {
    return (
      await refreshWslHostPairing(userDataPath, record.environmentId, {
        pairingCode: connection.pairingOffer,
        localPort: connection.localPort,
        remotePort: connection.remotePort,
        linuxUser: connection.linuxUser
      })
    ).pairingChanged
  } catch (error) {
    console.warn(`[wsl-hosts] Could not save the new pairing for ${record.distro}:`, error)
    return false
  }
}

/** Saves the host's live connection's pairing and ports; transports on a changed pairing retire. */
export async function saveWslHostConnection(
  deps: { userDataPath: () => string; pairingChanged: (environmentId: string) => void },
  record: WslHostDeploymentRecord | null,
  connections: { get(distro: string): WslOrcadConnection | null } | null
): Promise<void> {
  const connection = record ? connections?.get(record.distro) : null
  if (
    record &&
    connection &&
    (await persistWslHostConnection(deps.userDataPath(), record, connection))
  ) {
    deps.pairingChanged(record.environmentId)
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
    ...(runsAsOtherUserDetail(status, connection) ?? wslHostStatusDetail(record, status)),
    // Ready serves the incumbent; deferred serves nothing, so retain its Update/Force explanation.
    deferredUpdate:
      status.state === 'ready'
        ? (connection?.deferredUpdate ?? null)
        : status.state === 'failed'
          ? (status.deferredUpdate ?? null)
          : null,
    ...(record.pendingStop ? { removalPending: true } : {})
  }
}

/** A ready host pinned to an account that is no longer the distro's default says so (#49180). */
function runsAsOtherUserDetail(
  status: WslOrcadConnectionStatus,
  connection: WslOrcadConnection | null
): WslHostStatusDetail | null {
  const user = connection?.linuxUser
  const defaultUser = connection?.defaultLinuxUser
  if (status.state !== 'ready' || !user || !defaultUser) {
    return null
  }
  const { text, code, params } = wslHostStatusDetailText('runsAsOtherUser', { user, defaultUser })
  return codedDetail(text, code, params)
}

const UNVERIFIABLE_DETAIL_CODES: Record<WslLivenessUnverifiableReason, WslHostStatusDetailCode> = {
  'running-list-unavailable': 'runningListUnavailable',
  'guest-unanswered': 'guestUnanswered',
  'orcad-unanswered': 'orcadUnanswered'
}

type WslHostStatusDetail = Pick<WslHostStatus, 'detail' | 'detailCode' | 'detailParams'>

function codedDetail(
  detail: string,
  code: string | undefined,
  params: WslHostCopyParams | undefined
): WslHostStatusDetail {
  return {
    detail,
    ...(code ? { detailCode: code } : {}),
    ...(code && params ? { detailParams: params } : {})
  }
}

function wslHostStatusDetail(
  record: WslHostDeploymentRecord,
  status: WslOrcadConnectionStatus
): WslHostStatusDetail {
  if (status.state === 'unverifiable') {
    const { text, code } = wslHostStatusDetailText(UNVERIFIABLE_DETAIL_CODES[status.reason])
    return { detail: text, detailCode: code }
  }
  if (status.state === 'failed') {
    return codedDetail(status.reason, status.reasonCode, status.reasonParams)
  }
  if (status.state === 'connecting' && status.installLockWait) {
    const { text, code, params } = wslHostInstallLockWaitText(status.installLockWait)
    return codedDetail(text, code, params)
  }
  const stop = record.pendingStop
  return stop ? codedDetail(stop.reason, stop.reasonCode, stop.reasonParams) : { detail: null }
}

/** Only a connecting change names what an Add waits for; null for every other state. */
export function wslHostAddProgress(
  distro: string,
  status: WslOrcadConnectionStatus
): WslHostAddProgress | null {
  if (status.state !== 'connecting') {
    return null
  }
  const coded = status.installLockWait ? wslHostInstallLockWaitText(status.installLockWait) : null
  return {
    distro,
    ...(status.addStage ? { stage: status.addStage } : {}),
    detail: coded?.text ?? null,
    ...(coded ? { detailCode: coded.code } : {}),
    ...(coded?.params ? { detailParams: coded.params } : {})
  }
}

/** The registered WSL hosts; an unreadable store reads as none rather than failing the caller. */
export async function readWslHostRecordsQuietly(
  userDataPath: string
): Promise<WslHostDeploymentRecord[]> {
  try {
    const { deployments } = await readWslHostDeployments(userDataPath)
    // Every host command path reads records first, so the pins follow each read.
    pinWslHostLinuxUsers(deployments)
    return deployments
  } catch (error) {
    console.warn('[wsl-hosts] Could not read WSL host records:', error)
    return []
  }
}
