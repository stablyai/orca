import {
  sshRemotePtyLeaseAllowsReattach,
  type SshTerminateSessionsResult
} from '../../shared/ssh-types'
import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../shared/constants'
import { UNVERIFIED_PROCESS_EXIT_CODE } from '../../shared/terminal-exit-cause'
import { isSshPtyNotFoundError, SshPtyHeldByPreviousRelayError } from '../providers/ssh-pty-errors'
import { toAppSshPtyId, toRelaySshPtyId } from '../providers/ssh-pty-id'
import { isReattachHeldByPreviousRelay } from '../ssh/ssh-previous-relay-terminals'
import { listPreviousRelayPtyIds } from '../ssh/ssh-legacy-relay-routing'
import {
  clearProviderPtyState,
  deletePtyOwnership,
  getPtyIdsForConnection,
  getSshPtyProvider
} from './pty'
import { invalidateConnectAttempt } from './ssh-connect-attempt-registry'
import { currentRuntime, persistedStore } from './ssh-ipc-context'
import { ptyIncarnationById } from './pty/provider/ownership-state'
import type { TerminalIntentionalStopKind } from '../runtime/terminal-intentional-stops'
import { teardownSshTargetTransport } from './ssh-session-teardown'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'

export type SshTerminateSessionsOptions = {
  /** Records each stop as main's own, so every viewer keeps the tab through its exit. */
  intentionalStop?: TerminalIntentionalStopKind
  /** Each shell this call stopped, reported even when a later one fails. */
  onStopped?: (appPtyId: string) => void
}

/** Stops every relay terminal on the target and closes its transport (`ssh:terminateSessions`). */
export async function terminateSshTargetSessions(
  targetId: string,
  options: SshTerminateSessionsOptions = {}
): Promise<SshTerminateSessionsResult> {
  invalidateConnectAttempt(targetId)
  // Why (#12661): an offline sweep tears down local transport only. The caller must be able to tell
  // "the host stopped these" from "nobody asked the host", so carry the verdict out of the lifecycle queue.
  let outcome: SshTerminateSessionsResult = { terminated: 0, unverifiable: 0 }
  await runTargetLifecycle(targetId, async () => {
    const provider = getSshPtyProvider(targetId)
    const leases = persistedStore!.getSshRemotePtyLeases(targetId)
    const ptyIdsByRelayId = new Map<string, string>()
    // Why: only leases the app still believes it owns may force a reconnect; a lease whose route
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
    for (const lease of leases) {
      if (lease.state === 'terminated') {
        continue
      }
      // Why the predicate and not `state !== 'expired'`: an `expired` lease carrying no
      // retirement mark records only that reattach gave up, never that the remote shell died, so
      // it is exactly the orphan the user's terminate must reach — and reaching it needs the
      // relay, which is what the fence below demands. Only `supersededBy` / `relayIdRecycled`
      // prove the route is dead for good, and those stay unowned.
      trackPtyId(lease.ptyId, sshRemotePtyLeaseAllowsReattach(lease))
    }
    // A shell a relay runs without any lease here (a CLI-created terminal, or one a respawn
    // superseded on its tab) is still this host's; shutdown stops an earlier relay's held one there.
    for (const ptyId of await listRelayPtyIdsToStop(targetId, provider)) {
      trackPtyId(ptyId, false)
    }
    const ptyIds = Array.from(ptyIdsByRelayId, ([relayPtyId, appPtyId]) => ({
      relayPtyId,
      appPtyId
    }))

    if (ownedRelayIds.size > 0 && !provider) {
      throw new Error(
        `${SSH_TERMINATE_RECONNECT_REQUIRED}: SSH relay is not connected; reconnect before terminating remote sessions.`
      )
    }
    const shutdownResults = provider
      ? await Promise.allSettled(
          ptyIds.map(({ appPtyId }) =>
            shutdownAs(options, appPtyId, () =>
              provider.shutdown(appPtyId, { immediate: true, keepHistory: false })
            )
          )
        )
      : []
    if (!provider) {
      // Nothing observed these remote shells, so their state is unknown — not "nothing to do".
      outcome = { terminated: 0, unverifiable: ptyIds.length }
    }
    const shutdownFailures: string[] = []
    for (const [index, result] of shutdownResults.entries()) {
      const { appPtyId, relayPtyId } = ptyIds[index]
      if (
        result.status !== 'fulfilled' &&
        (result.reason instanceof SshPtyHeldByPreviousRelayError ||
          (await isReattachHeldByPreviousRelay(targetId, result.reason)))
      ) {
        // Not found here is not absence while an older build's relay may still run it (#25124).
        outcome = { ...outcome, unverifiable: outcome.unverifiable + 1 }
        continue
      }
      if (result.status !== 'fulfilled' && !isSshPtyNotFoundError(result.reason)) {
        shutdownFailures.push(
          `${relayPtyId}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
        )
        continue
      }
      clearProviderPtyState(appPtyId)
      deletePtyOwnership(appPtyId)
      persistedStore!.markSshRemotePtyLease(targetId, relayPtyId, 'terminated')
      reportStoppedPtyToRuntime(appPtyId)
      if (result.status === 'fulfilled') {
        options.onStopped?.(appPtyId)
      }
      outcome = { ...outcome, terminated: outcome.terminated + 1 }
    }
    if (shutdownFailures.length > 0) {
      // Why: a failed relay shutdown can leave the remote process alive in the grace window; keep the lease/session so the user can retry.
      throw new Error(`Failed to terminate SSH host sessions: ${shutdownFailures.join('; ')}`)
    }
    // Disposal marks every remaining lease terminated; an unverifiable PTY keeps its lease detached,
    // since only the leases this run proved terminated were marked so above.
    await teardownSshTargetTransport(targetId, (session) =>
      outcome.unverifiable > 0 ? session.detachAndPersist() : session.disposeAndPersist()
    )
  })
  return outcome
}

/** An unanswered listing adds nothing here; the move's census after the stop still asks the host. */
async function listRelayPtyIdsToStop(
  targetId: string,
  provider: ReturnType<typeof getSshPtyProvider>
): Promise<string[]> {
  if (!provider) {
    return []
  }
  const [current, previous] = await Promise.all([
    provider.listProcesses().then(
      (rows) => rows.map((row) => row.id),
      () => []
    ),
    listPreviousRelayPtyIds(targetId).catch(() => null)
  ])
  return [...current, ...(previous ?? [])]
}

/** Marks exactly this shell, from just before its shutdown, so earlier exits close normally. */
async function shutdownAs(
  options: SshTerminateSessionsOptions,
  appPtyId: string,
  shutdown: () => Promise<void>
): Promise<void> {
  const settle = options.intentionalStop
    ? currentRuntime?.intentionalPtyStops.mark(
        appPtyId,
        options.intentionalStop,
        ptyIncarnationById.get(appPtyId) ?? null
      )
    : undefined
  let stopped = false
  try {
    await shutdown()
    stopped = true
  } finally {
    settle?.(stopped)
  }
}

/**
 * Why: a relay that hangs up after its last shell stops never sends that exit, which left
 * `terminal list` showing the stopped shell as connected. The relay accepting the kill is not an
 * observed exit, so this is the stop sentinel, and a real exit already reported is kept.
 */
function reportStoppedPtyToRuntime(appPtyId: string): void {
  if (currentRuntime?.getPtyLivenessVerdict(appPtyId)?.status === 'exited') {
    return
  }
  currentRuntime?.onPtyExit(appPtyId, UNVERIFIED_PROCESS_EXIT_CODE)
}
