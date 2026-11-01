import type { DirectSshAuthority } from '../../../shared/ssh-types'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import { clearSshHostServerStatus } from '../../ssh/ssh-host-server-status'
import { isSshConnectionSolelyOwnedBy } from '../../ssh/connection/ssh-connection-attribution'
import {
  connectInFlight,
  invalidateConnectAttempt,
  isCurrentConnectAttempt
} from './ssh-connect-attempt-registry'
import { connectionManager, persistedStore, portForwardManager } from './ssh-ipc-context'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'
import { forgetPortForwardRestoreState } from './ssh-managed-port-forward-restore'
import { errorMessage } from '../../../shared/error-message'
import {
  forgetLegacyRelayTarget,
  stopLegacyRelayBridge
} from '../../ssh/legacy-relay/legacy-relay-bridge-registry'

export async function disconnectRegisteredSshTarget(targetId: string): Promise<void> {
  invalidateConnectAttempt(targetId)
  clearSshHostServerStatus(targetId)
  await runTargetLifecycle(targetId, () => teardownSshTargetTransport(targetId))
}

export async function removeRegisteredSshTarget(targetId: string): Promise<void> {
  const store = getSshTargetRegistryStore()
  if (!store) {
    return
  }
  invalidateConnectAttempt(targetId)
  clearSshHostServerStatus(targetId)
  await runTargetLifecycle(targetId, async () => {
    try {
      await teardownSshTargetTransport(targetId)
    } catch (err) {
      // Failed disconnect must not leave removed targets and their leases registered.
      console.warn(`[ssh] Failed to disconnect removed target ${targetId}: ${errorMessage(err)}`)
    }
    persistedStore?.removeSshRemotePtyLeases(targetId)
    forgetLegacyRelayTarget(targetId)
    store.removeTarget(targetId)
    // Target removal also retires its scoped browser cookie storage.
    try {
      const [partitions, storage] = await Promise.all([
        import('../../browser/local-ssh-browser-partitions'),
        import('../../browser/browser-route-partition-storage-runtime')
      ])
      await partitions.releaseLocalSshBrowserPartitionsForTarget(targetId)
      await storage.clearBrowserRoutePartitionStorageForLocalSshTarget(targetId)
      // A prepare can re-register during removal; sweep again after the release/clear race.
      await new Promise((resolve) => setTimeout(resolve, 500))
      await partitions.releaseLocalSshBrowserPartitionsForTarget(targetId)
      await storage.clearBrowserRoutePartitionStorageForLocalSshTarget(targetId)
    } catch (error) {
      console.warn(
        `[ssh] Failed to clear browser partitions for removed target ${targetId}: ${errorMessage(error)}`
      )
    }
  })
}

export async function teardownSshTargetTransport(targetId: string): Promise<void> {
  // COMPAT(legacy-relay-bridge): hangs up only this client; the relays keep their terminals.
  stopLegacyRelayBridge(targetId)
  forgetPortForwardRestoreState(targetId)
  // Release listeners before reconnect; independent system-SSH tunnels also retain ports after session disconnect.
  const [forwards, managedTunnels, disconnect] = await Promise.allSettled([
    portForwardManager?.removeAllForwards(targetId),
    // Import lazily: SSH-only callers may lack the app paths resolved by managed tunnels.
    import('../../managed-server/lifecycle/orcad-managed-tunnel').then((tunnels) =>
      tunnels.closeOrcadManagedTunnelsForTarget(targetId)
    ),
    (async () => connectionManager?.disconnect(targetId))()
  ])
  if (forwards.status === 'rejected') {
    throw forwards.reason
  }
  if (managedTunnels.status === 'rejected') {
    throw managedTunnels.reason
  }
  if (disconnect.status === 'rejected') {
    throw disconnect.reason
  }
}

/** Close decision-created transports only while no completed or pending successor can adopt them. */
export async function abandonDecisionTransport(
  targetId: string,
  owner: symbol,
  authority: DirectSshAuthority
): Promise<void> {
  const opened = connectionManager!.getConnection(targetId)
  const newer = connectInFlight.get(targetId)
  // Pending successors may reuse the transport before adopting it; the current attempt cannot have a newer owner.
  if (
    !opened ||
    !isSshConnectionSolelyOwnedBy(opened, owner) ||
    (newer &&
      isCurrentConnectAttempt(targetId, newer.authority) &&
      !isCurrentConnectAttempt(targetId, authority))
  ) {
    return
  }
  stopLegacyRelayBridge(targetId)
  try {
    await connectionManager!.disconnectConnection(targetId, opened)
  } catch (error) {
    // Preserve the cancellation error over a secondary teardown failure.
    console.warn(
      `[ssh] Failed to close the transport a cancelled decision opened for ${targetId}: ${errorMessage(error)}`
    )
  }
}
