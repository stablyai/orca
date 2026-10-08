import { isLiveSshPtyLease } from '../../shared/ssh-pty-lease-liveness'
import { ipcMain } from 'electron'
import type { SshTarget } from '../../shared/ssh-types'
import { toAppSshPtyId } from '../providers/ssh-pty-id'
import { rotateSshProviderAuthority } from '../ssh/ssh-provider-authority'
import { forceStopRelayForTarget } from '../ssh/ssh-relay-reset'
import { setSshTargetRegistryHandlers, getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { clearProviderPtyState, deletePtyOwnership, getPtyIdsForConnection } from './pty'
import { activeSessions } from './ssh-active-relay-sessions'
import {
  assertSshConnectsNotFenced,
  connectInFlight,
  credentialRequestedForTarget,
  resetRelayInFlight,
  runSshTestConnectionProbe
} from './ssh-connect-attempt-registry'
import { connectTarget } from './ssh-connect-flow'
import { connectionManager, persistedStore } from './ssh-ipc-context'
import { getPublicSshState } from './ssh-renderer-broadcast'
import { disconnectRegisteredSshTarget, teardownActiveSshSession } from './ssh-session-teardown'
import { terminateSshTargetSessions } from './ssh-terminate-sessions'
import { assertNotManagedServerHost } from './ssh-target-crud-handlers'
import { moveSshHostToManagedServer } from './ssh-managed-server-move'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'

async function doResetRelay(targetId: string, target: SshTarget): Promise<void> {
  const inFlightConnect = connectInFlight.get(targetId)
  if (inFlightConnect) {
    try {
      // Why: resetting activeSessions mid-deploy would dispose the session doConnect will use.
      await inFlightConnect.promise
    } catch {
      // The reset can still recover a stale remote relay after a failed connect.
    }
  }

  rotateSshProviderAuthority(targetId)
  const session = activeSessions.get(targetId)
  if (session) {
    // Why: detach() not dispose() — reset has its own stale-lease semantics below that dispose()'s clean-termination recording would hide.
    await teardownActiveSshSession(targetId, (capturedSession) =>
      capturedSession.detachAndPersist()
    )
  }

  const existingConn = connectionManager!.getConnection(targetId)
  let conn = existingConn
  if (!conn) {
    // Why re-check: admission fenced this reset before it parked on the in-flight connect, so shutdown
    // may have started (and drained) while we waited — opening a transport now would outlive the drain.
    assertSshConnectsNotFenced()
    conn = await connectionManager!.connect(target)
  }
  let relayStopAcknowledged = false
  try {
    await forceStopRelayForTarget(conn, targetId)
    relayStopAcknowledged = true
  } finally {
    const ptyIds = new Set(getPtyIdsForConnection(targetId))
    for (const lease of persistedStore!.getSshRemotePtyLeases(targetId)) {
      // Deliberately the raw state, not `sshRemotePtyLeaseAllowsReattach`: this asks which routes
      // the force-stop just invalidated, not which leases may be reattached. An already-`expired`
      // lease has no route left for reset to retire — re-marking it `expired` is a no-op write, and
      // any local handle this connection really holds arrives through `getPtyIdsForConnection`
      // above, whatever the lease says. Reset also may not upgrade it to `terminated`: killing the
      // relay daemon makes its PTYs permanently unreachable, which is not evidence they exited
      // (docs/reference/ssh-execution-boundary.md). Nothing here can adopt a stranger either — the
      // replacement relay namespaces every id under a fresh mint epoch, so an old orphan lease can
      // only fail its next reattach.
      if (isLiveSshPtyLease(lease)) {
        ptyIds.add(lease.ptyId)
        // Why: only a host-acknowledged force-stop may retire a lease. When it threw we never
        // observed those shells, so expiring them would record a verdict we do not hold; mirrors
        // ssh:terminateSessions, and the next connect re-attaches (or expires) them on evidence.
        if (relayStopAcknowledged) {
          persistedStore!.markSshRemotePtyLease(targetId, lease.ptyId, 'expired')
        }
      }
    }
    // Why: reset force-kills the remote relay, so every local PTY handle it owned is stale even if the reset command failed after SIGTERM.
    for (const ptyId of ptyIds) {
      const appPtyId = toAppSshPtyId(targetId, ptyId)
      clearProviderPtyState(appPtyId)
      deletePtyOwnership(appPtyId)
    }
    // Why: reset's connect() may trip onCredentialRequest; clear so a later non-prompting doConnect doesn't persist lastRequiredPassphrase=true.
    credentialRequestedForTarget.delete(targetId)
    await connectionManager!.disconnect(targetId)
  }
}

export function registerSshConnectionHandlers(): void {
  setSshTargetRegistryHandlers({
    connect: connectTarget,
    getState: (targetId: string) => getPublicSshState(targetId)
  })

  ipcMain.handle('ssh:connect', async (_event, args: { targetId: string }) => {
    return connectTarget(args.targetId)
  })

  ipcMain.handle('ssh:disconnect', async (_event, args: { targetId: string }) => {
    await disconnectRegisteredSshTarget(args.targetId)
  })

  ipcMain.handle(
    'ssh:terminateSessions',
    (_event, args: { targetId: string; forRemoval?: boolean }) => {
      // Why here: only main sees a fence that landed after the renderer loaded its targets.
      if (args.forRemoval) {
        assertNotManagedServerHost(args.targetId)
      }
      return terminateSshTargetSessions(args.targetId)
    }
  )

  ipcMain.handle('ssh:moveToManagedServer', (_event, args: { targetId: string }) =>
    moveSshHostToManagedServer(args.targetId)
  )

  ipcMain.handle('ssh:resetRelay', (_event, args: { targetId: string }) => {
    const existingReset = resetRelayInFlight.get(args.targetId)
    if (existingReset) {
      return existingReset
    }

    const target = getSshTargetRegistryStore()!.getTarget(args.targetId)
    if (!target) {
      throw new Error(`SSH target "${args.targetId}" not found`)
    }
    // Why: reset opens its own transport, so it must be fenced by shutdown the same way connect is.
    assertSshConnectsNotFenced()

    let resetPromise: Promise<void>
    resetPromise = runTargetLifecycle(args.targetId, () =>
      doResetRelay(args.targetId, target)
    ).finally(() => {
      if (resetRelayInFlight.get(args.targetId) === resetPromise) {
        resetRelayInFlight.delete(args.targetId)
      }
    })
    resetRelayInFlight.set(args.targetId, resetPromise)
    return resetPromise
  })

  ipcMain.handle('ssh:getState', (_event, args: { targetId: string }) => {
    return getPublicSshState(args.targetId)
  })

  // Why: auto-connect callers need to know whether connecting will prompt; true when the last connect required a credential and no live conn has it cached.
  ipcMain.handle('ssh:needsPassphrasePrompt', (_event, args: { targetId: string }) => {
    const target = getSshTargetRegistryStore()!.getTarget(args.targetId)
    if (!target?.lastRequiredPassphrase) {
      return false
    }
    const conn = connectionManager!.getConnection(args.targetId)
    return !conn?.hasCachedCredential()
  })

  ipcMain.handle('ssh:testConnection', async (_event, args: { targetId: string }) => {
    const target = getSshTargetRegistryStore()!.getTarget(args.targetId)
    if (!target) {
      throw new Error(`SSH target "${args.targetId}" not found`)
    }

    // Why: with a live/reconnecting session, testConnection's disconnect() would tear down the relay stack (PTYs, watchers), so skip.
    const existingSession = activeSessions.get(args.targetId)
    const sessionState = existingSession?.getState()
    if (
      sessionState === 'ready' ||
      sessionState === 'deploying' ||
      sessionState === 'reconnecting'
    ) {
      return { success: true, state: connectionManager!.getState(args.targetId) }
    }

    // Why: testConnection's disconnect() would tear down an in-flight connect's relay deployment; await it instead.
    const inFlight = connectInFlight.get(args.targetId)
    if (inFlight) {
      try {
        const state = await inFlight.promise
        return { success: true, state }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }

    // Why a tracked promise and not just the id: a probe holds a real transport that no session owns,
    // so shutdown has to be able to join it before the final drain disconnects what is left.
    const probe = runSshTestConnectionProbe(args.targetId, async () => {
      // Why: a probe transport opened after the shutdown drain would outlive orderly teardown.
      assertSshConnectsNotFenced()
      const conn = await connectionManager!.connect(target)
      const state = conn.getState()
      await connectionManager!.disconnect(args.targetId)
      return state
    })
    try {
      return { success: true, state: await probe }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })
}
