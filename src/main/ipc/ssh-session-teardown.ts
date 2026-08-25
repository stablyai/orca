import type { SshConnection } from '../ssh/ssh-connection'
import type { SshRelaySession } from '../ssh/ssh-relay-session'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { activeSessions } from './ssh-active-relay-sessions'
import { invalidateConnectAttempt } from './ssh-connect-attempt-registry'
import { connectionManager, persistedStore, portForwardManager } from './ssh-ipc-context'
import { clearRelayLostBackoff } from './ssh-relay-lost-backoff'
import { clearRelayStateOverride } from './ssh-renderer-broadcast'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'

export async function disconnectRegisteredSshTarget(targetId: string): Promise<void> {
  invalidateConnectAttempt(targetId)
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
  await runTargetLifecycle(targetId, async () => {
    try {
      // Why: removal is destructive; dispose so remote PTYs cannot reattach to a deleted target.
      await teardownSshTargetTransport(targetId, (session) => session.disposeAndPersist())
    } catch (err) {
      // Why: a failed disconnect must not block metadata removal, else the target lingers in the store with uncleaned leases.
      console.warn(
        `[ssh] Failed to disconnect removed target ${targetId}: ${err instanceof Error ? err.message : String(err)}`
      )
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
        `[ssh] Failed to clear browser partitions for removed target ${targetId}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  })
}

export async function teardownSshTargetTransport(
  targetId: string,
  teardown: (session: SshRelaySession) => void | Promise<void>
): Promise<void> {
  let transportDisconnect: Promise<{ ok: true } | { ok: false; error: unknown }>
  try {
    transportDisconnect = Promise.resolve(connectionManager?.disconnect(targetId)).then(
      () => ({ ok: true }) as const,
      (error: unknown) => ({ ok: false, error }) as const
    )
  } catch (error) {
    transportDisconnect = Promise.resolve({ ok: false, error })
  }
  const sessionTeardown = teardownActiveSshSession(targetId, teardown).then(
    () => ({ ok: true }) as const,
    (error: unknown) => ({ ok: false, error }) as const
  )
  const [disconnectResult, teardownResult] = await Promise.all([
    transportDisconnect,
    sessionTeardown
  ])
  if (!teardownResult.ok) {
    throw teardownResult.error
  }
  if (!disconnectResult.ok) {
    throw disconnectResult.error
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
    console.warn(
      `[ssh] Failed to detach abandoned session for ${targetId}: ${error instanceof Error ? error.message : String(error)}`
    )
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
      `[ssh] Failed to disconnect cancelled connect transport for ${targetId}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
