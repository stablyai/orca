import type { DirectSshAuthority } from '../../shared/ssh-types'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { clearSshHostServerStatus } from '../ssh/ssh-host-server-status'
import { isSshConnectionSolelyOwnedBy } from '../ssh/ssh-connection-attribution'
import {
  connectInFlight,
  invalidateConnectAttempt,
  isCurrentConnectAttempt
} from './ssh-connect-attempt-registry'
import { connectionManager, persistedStore, portForwardManager } from './ssh-ipc-context'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'
import { errorMessage } from '../../shared/error-message'

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
      // Why: a failed disconnect must not block metadata removal, else the target lingers in the store with uncleaned leases.
      console.warn(`[ssh] Failed to disconnect removed target ${targetId}: ${errorMessage(err)}`)
    }
    persistedStore?.removeSshRemotePtyLeases(targetId)
    store.removeTarget(targetId)
    // Why: removal is the storage boundary — the target's browser cookie jars
    // must not outlive the record that scoped them.
    try {
      const [partitions, storage] = await Promise.all([
        import('../browser/local-ssh-browser-partitions'),
        import('../browser/browser-route-partition-storage-runtime')
      ])
      await partitions.releaseLocalSshBrowserPartitionsForTarget(targetId)
      await storage.clearBrowserRoutePartitionStorageForLocalSshTarget(targetId)
      // Why (review P2-2): a prepare racing the removal can re-register between
      // release and clear; one delayed second pass reclaims what slipped
      // through (mirrors the environment-removal retry).
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
  // Why first: local listeners must be released before disconnect completes, else an immediate
  // reconnect hits EADDRINUSE.
  const [forwards, disconnect] = await Promise.allSettled([
    portForwardManager?.removeAllForwards(targetId),
    (async () => connectionManager?.disconnect(targetId))()
  ])
  if (forwards.status === 'rejected') {
    throw forwards.reason
  }
  if (disconnect.status === 'rejected') {
    throw disconnect.reason
  }
}

/**
 * A cancelled connect, or one whose server decision failed, closes the transport its own decision
 * opened (a census, deploy or conversion), and only while nothing newer took it over: a completed
 * replacement connect or a managed tunnel adopts it, and a pending replacement may be about to.
 */
export async function abandonDecisionTransport(
  targetId: string,
  owner: symbol,
  authority: DirectSshAuthority
): Promise<void> {
  const opened = connectionManager!.getConnection(targetId)
  const newer = connectInFlight.get(targetId)
  // A pending replacement may be about to reuse it, though it has not adopted it yet. While this
  // attempt is still current the in-flight entry is its own, so nothing newer can exist.
  if (
    !opened ||
    !isSshConnectionSolelyOwnedBy(opened, owner) ||
    (newer &&
      isCurrentConnectAttempt(targetId, newer.authority) &&
      !isCurrentConnectAttempt(targetId, authority))
  ) {
    return
  }
  try {
    await connectionManager!.disconnectConnection(targetId, opened)
  } catch (error) {
    // Why: the caller is about to throw the cancellation; a teardown throw must not replace it.
    console.warn(
      `[ssh] Failed to close the transport a cancelled decision opened for ${targetId}: ${errorMessage(error)}`
    )
  }
}
