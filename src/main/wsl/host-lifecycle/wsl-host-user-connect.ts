/**
 * The user's own Connect of a saved WSL host: may boot its distro, and an intent retries or forces
 * an update. "Restart as WSL host" (#43632) first stops a server something other than the WSL host
 * started (usually an SSH host), ending its terminals as Remove does but keeping the host, so the
 * connect that follows starts it as a WSL host.
 */
import type { WslHostDeploymentRecord } from '../../../shared/remote-runtime/host-store/wsl-host-deployment-store'
import type { WslHostConnectRequest } from './wsl-host-connect-request'
import type { WslHostConnector, WslHostServiceDependencies } from './wsl-host-connector-contract'
import { assertWslHostRunAllowed } from './wsl-host-gate'
import { admitConnectToPendingHost } from './wsl-host-removal'

export type WslHostUserConnectPort = {
  deps: WslHostServiceDependencies
  connector: WslHostConnector
  /** Hosts whose server is stopping; nothing else reconnects them meanwhile. */
  removing: Set<string>
  parked: Set<string>
}

export async function connectWslHostForUser(
  port: WslHostUserConnectPort,
  record: WslHostDeploymentRecord,
  {
    withdrawPendingRemoval,
    ...options
  }: WslHostConnectRequest & { withdrawPendingRemoval: boolean }
): Promise<void> {
  const { environmentId, distro } = record
  assertWslHostRunAllowed(port.deps, port.removing, environmentId)
  await admitConnectToPendingHost(port.deps.userDataPath(), record, withdrawPendingRemoval)
  port.connector.forgetPairingFailures?.(environmentId)
  port.parked.delete(environmentId)
  const { intent, pastUncountedTerminals } = options
  if (intent !== 'restart-as-wsl-host') {
    await port.connector.connect(distro, {
      ...(intent ? { intent } : {}),
      ...(pastUncountedTerminals ? { pastUncountedTerminals } : {})
    })
    return
  }
  port.removing.add(environmentId)
  try {
    await stopServerForRestart(port.connector, record)
  } finally {
    port.removing.delete(environmentId)
  }
  await port.connector.connect(distro)
}

async function stopServerForRestart(
  connector: WslHostConnector,
  record: WslHostDeploymentRecord
): Promise<void> {
  const stop = await connector.stopServer(record.distro, record.environmentId)
  if (!stop.stopped) {
    throw new Error(stop.reason)
  }
  // Another Orca still uses it: this desktop only let go, and the same server would come back.
  if (stop.keptForOtherDesktops?.length) {
    throw new Error(
      `Another Orca uses this server (${stop.keptForOtherDesktops.join(', ')}), so it kept ` +
        'running. Close Orca there, then restart it as a WSL host again.'
    )
  }
}
