/** E9 for runtime calls: a poll or fetch reaches a WSL host only without booting its distro. */
import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import { deferUntilWslDistroRunning } from '../wsl-background-distro-gate'
import { rethrowRetryable, settlingConnectFailure } from './wsl-host-connect-failure'
import type { WslHostConnector, WslHostServiceDependencies } from './wsl-host-connector-contract'
import {
  wslHostNotConnectedMessage,
  wslHostStoppedMessage,
  WSL_HOST_REMOVING_MESSAGE,
  wslHostRunRefusal
} from './wsl-host-add-admission'
import { admitConnectToPendingHost } from './wsl-host-removal'
import type { WslOrcadConnection } from './wsl-orcad-connection'

export type WslHostRuntimeCallPort = {
  record: WslHostDeploymentRecord | null
  connector: WslHostConnector | null
  deps: WslHostServiceDependencies
  removing: ReadonlySet<string>
  /** Hosts a confirmed stop parked: no runtime call reconnects them until the distro runs again. */
  parked: Set<string>
  isVisible: () => boolean
  /** Shown as liveness shows a stop, so the host's panes offer Start. */
  publishStopped: (record: WslHostDeploymentRecord) => void
  publishReady: (record: WslHostDeploymentRecord, connection: WslOrcadConnection) => void
  /** The same call again, once the distro is confirmed running. */
  retry: () => Promise<void>
}

/**
 * It reconnects only to a distro confirmed running and only for visible work; a confirmed stop
 * parks the host until the distro runs again (started by the user or elsewhere), never booting it.
 */
export async function ensureWslHostForRuntimeCall(
  environmentId: string,
  port: WslHostRuntimeCallPort
): Promise<void> {
  const { record, connector, deps, parked } = port
  if (!record || !connector) {
    return
  }
  const reachability = await connector.reachability(record.distro, environmentId)
  if (reachability === 'available') {
    return
  }
  const refusal = wslHostRunRefusal(deps)
  if (refusal || port.removing.has(environmentId)) {
    throw new Error(refusal?.message ?? WSL_HOST_REMOVING_MESSAGE)
  }
  // A pending host never reconnects for a runtime call.
  admitConnectToPendingHost(deps.userDataPath(), record, false)
  if (reachability === 'stopped') {
    parkStopped(record, port)
  }
  if (parked.has(environmentId)) {
    throw new Error(wslHostStoppedMessage(record.distro))
  }
  // Unconfirmed (running list unreadable, or possibly stale right after an exit) or not
  // visible: refuse rather than risk a boot; liveness publishes the verdict.
  if (reachability !== 'unreachable' || !port.isVisible()) {
    throw new Error(wslHostNotConnectedMessage(record.distro))
  }
  if (connector.isSettling(record.distro)) {
    throw settlingConnectFailure(record.distro)
  }
  await connector.connect(record.distro, { noBoot: true }).catch(rethrowRetryable(record.distro))
}

// verify-7: a keystroke met the stop before liveness did; parked silently, the pane died unexplained.
function parkStopped(record: WslHostDeploymentRecord, port: WslHostRuntimeCallPort): void {
  const { environmentId, distro } = record
  if (!port.parked.has(environmentId)) {
    port.parked.add(environmentId)
    port.publishStopped(record)
  }
  const deferUntilRunning = port.deps.deferUntilRunning ?? deferUntilWslDistroRunning
  deferUntilRunning(distro, `wsl-host-parked:${environmentId}`, () => {
    if (port.parked.delete(environmentId)) {
      void resumeAfterStop(record, port).catch(() => {})
    }
  })
}

async function resumeAfterStop(
  record: WslHostDeploymentRecord,
  port: WslHostRuntimeCallPort
): Promise<void> {
  // A stop published after liveness had already reconnected would leave Start on a working host.
  const connection = port.connector?.get(record.distro) ?? null
  if (
    connection &&
    (await port.connector?.reachability(record.distro, record.environmentId)) === 'available'
  ) {
    port.publishReady(record, connection)
    return
  }
  if (port.isVisible()) {
    await port.retry()
  }
}
