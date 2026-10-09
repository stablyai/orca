import type { DirectSshAuthority } from '../../shared/ssh-types'
import type { SshConnection } from '../ssh/ssh-connection'
import type { SshRelaySession } from '../ssh/ssh-relay-session'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { clearSshHostServerStatus } from '../ssh/ssh-host-server-status'
import { recordSshRelayRuntimeStep } from '../ssh/ssh-host-node-runtime-mode'
import { isSshConnectionSolelyOwnedBy } from '../ssh/ssh-connection-attribution'
import { activeSessions } from './ssh-active-relay-sessions'
import {
  connectInFlight,
  invalidateConnectAttempt,
  isCurrentConnectAttempt
} from './ssh-connect-attempt-registry'
import { connectionManager, persistedStore, portForwardManager } from './ssh-ipc-context'
import { clearRelayLostBackoff } from './ssh-relay-lost-backoff'
import { clearRelayStateOverride } from './ssh-renderer-broadcast'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'
import { errorMessage } from '../../shared/error-message'

export async function disconnectRegisteredSshTarget(targetId: string): Promise<void> {
  invalidateConnectAttempt(targetId)
  clearSshHostServerStatus(targetId)
  await runTargetLifecycle(targetId, () =>
    teardownSshTargetTransport(targetId, (session) => session.detachAndPersist())
  )
}

export async function removeRegisteredSshTarget(targetId: string): Promise<void> {
  const store = getSshTargetRegistryStore()
  if (!store) {
    return
  }
  invalidateConnectAttempt(targetId)
  clearSshHostServerStatus(targetId)
  recordSshRelayRuntimeStep(targetId, false)
  await runTargetLifecycle(targetId, async () => {
    try {
      // Why: removal is destructive; dispose so remote PTYs cannot reattach to a deleted target.
      await teardownSshTargetTransport(targetId, (session) => session.disposeAndPersist())
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

export async function teardownSshTargetTransport(
  targetId: string,
  teardown: (session: SshRelaySession) => void | Promise<void>
): Promise<void> {
  // Why: start the transport disconnect before session teardown; the async wrapper turns a sync throw into a rejection.
  const transportDisconnect = (async () => connectionManager?.disconnect(targetId))()
  const [teardownResult, disconnectResult] = await Promise.allSettled([
    teardownActiveSshSession(targetId, teardown),
    transportDisconnect
  ])
  if (teardownResult.status === 'rejected') {
    throw teardownResult.reason
  }
  if (disconnectResult.status === 'rejected') {
    throw disconnectResult.reason
  }
}

export async function teardownActiveSshSession(
  targetId: string,
  teardown: (session: SshRelaySession) => void | Promise<void>
): Promise<void> {
  const session = activeSessions.get(targetId)
  if (!session) {
    return
  }
  let teardownError: { error: unknown } | null = null
  try {
    // Why: await port teardown so local listeners are released before disconnect/remove completes, else an immediate reconnect hits EADDRINUSE.
    await portForwardManager?.removeAllForwards(targetId)
  } catch (error) {
    teardownError = { error }
  }
  try {
    await teardown(session)
  } catch (error) {
    teardownError ??= { error }
  }
  if (activeSessions.get(targetId) === session) {
    activeSessions.delete(targetId)
    clearRelayLostBackoff(targetId)
    clearRelayStateOverride(targetId)
  }
  if (teardownError) {
    throw teardownError.error
  }
}

// Why: a dropped session must detach, not just leave activeSessions — detach releases the SSH PTY
// consumer identity so the next connect reclaims its owner lease instead of minting a new one.
// Why awaited, and why the map entry outlives the await: a retry can start the moment this returns,
// so it must either find the session (and await this same latched teardown at the existing-session
// path) or find nothing because the 'detached' lease write is already durable. Deleting first lets a
// fast reconnect mark leases 'attached' and then have this session's late 'detached' write clobber it.
export async function abandonFailedSshSession(
  targetId: string,
  session: SshRelaySession
): Promise<void> {
  // Why: detachAndPersist transitions recovery ownership synchronously; only durability is awaited.
  try {
    await session.detachAndPersist()
  } catch (error) {
    // Why: a teardown throw must not mask the connect error the caller is about to rethrow.
    console.warn(`[ssh] Failed to detach abandoned session for ${targetId}: ${errorMessage(error)}`)
  }
  if (activeSessions.get(targetId) === session) {
    activeSessions.delete(targetId)
  }
}

// Why: a connect cancelled after its transport already opened still owns that transport and its
// unpublished session — nothing else will reach them, so it has to close them itself. Why only the
// connection it minted, and by identity: disconnecting by target id (or closing a transport it merely
// reused) would tear down the replacement connect's live transport.
export async function abandonCancelledConnectAttempt(
  targetId: string,
  session: SshRelaySession,
  mintedConnection: SshConnection | null
): Promise<void> {
  // Why the identity guard: every path that removes a session from activeSessions detaches it first,
  // so re-detaching a superseded session would only clobber the replacement's lease state.
  if (activeSessions.get(targetId) === session) {
    await abandonFailedSshSession(targetId, session)
  }
  if (!mintedConnection) {
    return
  }
  try {
    await connectionManager!.disconnectConnection(targetId, mintedConnection)
  } catch (error) {
    // Why: the caller is about to throw the cancellation; a teardown throw must not replace it.
    console.warn(
      `[ssh] Failed to disconnect cancelled connect transport for ${targetId}: ${errorMessage(error)}`
    )
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
