import {
  sshRemotePtyLeaseAllowsReattach,
  type SshTerminateSessionsResult
} from '../../shared/ssh-types'
import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../shared/constants'
import { isSshPtyNotFoundError } from '../providers/ssh-pty-errors'
import { toAppSshPtyId, toRelaySshPtyId } from '../providers/ssh-pty-id'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import {
  clearProviderPtyState,
  deletePtyOwnership,
  getPtyIdsForConnection,
  getSshPtyProvider
} from './pty'
import { invalidateConnectAttempt } from './ssh-connect-attempt-registry'
import { persistedStore } from './ssh-ipc-context'
import { withSshMaintenanceRelay } from './ssh-maintenance-channel'
import { teardownSshTargetTransport } from './ssh-session-teardown'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'

type RemotePty = { relayPtyId: string; appPtyId: string }
type ShutdownRemotePty = (pty: RemotePty) => Promise<unknown>

/**
 * The user's "end terminals". A live relay session ends them itself; otherwise a maintenance
 * channel reaches the relay without registering anything, so a host the user disconnected stays
 * disconnected. Why inside the lifecycle queue: it serializes with the user's Connect/Disconnect.
 */
export async function terminateSshTargetSessions(
  targetId: string
): Promise<SshTerminateSessionsResult> {
  invalidateConnectAttempt(targetId)
  let outcome: SshTerminateSessionsResult = { terminated: 0, unverifiable: 0 }
  await runTargetLifecycle(targetId, async () => {
    outcome = await terminateRemoteSessions(targetId)
    await teardownSshTargetTransport(targetId, (session) => session.disposeAndPersist())
  })
  return outcome
}

async function terminateRemoteSessions(targetId: string): Promise<SshTerminateSessionsResult> {
  const { ptys, ownedCount } = collectRemotePtys(targetId)
  const provider = getSshPtyProvider(targetId)
  if (provider) {
    return terminateReachableSessions(targetId, ptys, ({ appPtyId }) =>
      provider.shutdown(appPtyId, { immediate: true, keepHistory: false })
    )
  }
  if (ownedCount === 0) {
    // Why (#12661): nothing observed these remote shells, so their state is unknown — not "nothing to do".
    return { terminated: 0, unverifiable: ptys.length }
  }
  return terminateOverMaintenanceRelay(targetId, ptys)
}

async function terminateOverMaintenanceRelay(
  targetId: string,
  ptys: readonly RemotePty[]
): Promise<SshTerminateSessionsResult> {
  let reachedRelay = false
  try {
    const target = getSshTargetRegistryStore()?.getTarget(targetId)
    if (!target) {
      throw new Error(`SSH target "${targetId}" not found`)
    }
    return await withSshMaintenanceRelay(target, (mux) => {
      reachedRelay = true
      return terminateReachableSessions(targetId, ptys, ({ relayPtyId }) =>
        mux.request('pty.shutdown', { id: relayPtyId, immediate: true, keepHistory: false })
      )
    })
  } catch (error) {
    if (reachedRelay) {
      throw error
    }
    // Why the fence code: nothing reached the host, and Remove tolerates exactly that (#2626).
    throw new Error(
      `${SSH_TERMINATE_RECONNECT_REQUIRED}: could not reach the SSH host to end its terminals: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function collectRemotePtys(targetId: string): { ptys: RemotePty[]; ownedCount: number } {
  const ptyIdsByRelayId = new Map<string, string>()
  // Why: only leases the app still believes it owns may force a dial; a lease whose route
  // died for good is swept opportunistically instead, so a target that can no longer answer
  // never blocks its own removal (issue #2626, and the renderer tolerates the refusal there).
  const ownedRelayIds = new Set<string>()
  const trackPtyId = (ptyId: string, owned: boolean): void => {
    const relayPtyId = toRelaySshPtyId(targetId, ptyId)
    if (!ptyIdsByRelayId.has(relayPtyId)) {
      ptyIdsByRelayId.set(relayPtyId, toAppSshPtyId(targetId, ptyId))
    }
    if (owned) {
      ownedRelayIds.add(relayPtyId)
    }
  }
  for (const ptyId of getPtyIdsForConnection(targetId)) {
    trackPtyId(ptyId, true)
  }
  for (const lease of persistedStore!.getSshRemotePtyLeases(targetId)) {
    if (lease.state === 'terminated') {
      continue
    }
    // Why the predicate and not `state !== 'expired'`: an `expired` lease carrying no
    // retirement mark records only that reattach gave up, never that the remote shell died, so
    // it is exactly the orphan the user's terminate must reach — and reaching it needs the
    // relay. Only `supersededBy` / `relayIdRecycled` prove the route is dead for good, and
    // those stay unowned.
    trackPtyId(lease.ptyId, sshRemotePtyLeaseAllowsReattach(lease))
  }
  const ptys = Array.from(ptyIdsByRelayId, ([relayPtyId, appPtyId]) => ({ relayPtyId, appPtyId }))
  return { ptys, ownedCount: ownedRelayIds.size }
}

async function terminateReachableSessions(
  targetId: string,
  ptys: readonly RemotePty[],
  shutdown: ShutdownRemotePty
): Promise<SshTerminateSessionsResult> {
  let outcome: SshTerminateSessionsResult = { terminated: 0, unverifiable: 0 }
  const shutdownResults = await Promise.allSettled(ptys.map((pty) => shutdown(pty)))
  const shutdownFailures: string[] = []
  for (const [index, result] of shutdownResults.entries()) {
    const { appPtyId, relayPtyId } = ptys[index]
    if (result.status !== 'fulfilled' && !isSshPtyNotFoundError(result.reason)) {
      shutdownFailures.push(
        `${relayPtyId}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
      )
      continue
    }
    clearProviderPtyState(appPtyId)
    deletePtyOwnership(appPtyId)
    persistedStore!.markSshRemotePtyLease(targetId, relayPtyId, 'terminated')
    outcome = { ...outcome, terminated: outcome.terminated + 1 }
  }
  if (shutdownFailures.length > 0) {
    // Why: a failed relay shutdown can leave the remote process alive in the grace window; keep the lease/session so the user can retry.
    throw new Error(`Failed to terminate SSH host sessions: ${shutdownFailures.join('; ')}`)
  }
  return outcome
}
