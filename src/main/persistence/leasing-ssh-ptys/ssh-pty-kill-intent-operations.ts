import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  MAX_SSH_PENDING_PTY_KILLS_PER_TARGET,
  isSshPendingPtyKillExpired,
  pendingSshPtyKillEntries,
  prunePendingSshPtyKills,
  type SshPendingPtyKill,
  type SshPendingPtyKillEntry
} from '../../../shared/ssh-pending-pty-kill'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import type { SshPtyLeaseOperations } from './ssh-pty-lease-operations'

/** Every recorded-but-undelivered stop for a target, newest first, TTL-filtered and capped.
 *  Returned with stored (target-local) relay pty ids, which is what `pty.shutdown` takes. */
export function getSshRemotePtyKillIntents(
  state: PersistedState,
  targetId: string,
  now: number
): SshPendingPtyKillEntry[] {
  const leases = (state.sshRemotePtyLeases ?? []).filter((lease) => lease.targetId === targetId)
  return prunePendingSshPtyKills(pendingSshPtyKillEntries(leases), now)
}

/** Deletes orders past their TTL, durably.
 *
 *  The read path filters them out too, but filtering alone would leave the field on disk forever
 *  and make the cap the only thing that ever reclaimed it. This is the TTL retirement path, and it
 *  deliberately leaves `state` alone: an order aging out observes nothing about the process. */
export function pruneExpiredSshRemotePtyKillIntents(
  operations: SshPtyLeaseOperations,
  targetId: string,
  now: number
): void {
  let changed = false
  for (const lease of operations.state.sshRemotePtyLeases ?? []) {
    if (
      lease.targetId === targetId &&
      lease.pendingKill &&
      isSshPendingPtyKillExpired(lease.pendingKill, now)
    ) {
      delete lease.pendingKill
      lease.updatedAt = now
      changed = true
    }
  }
  if (changed) {
    operations.flush()
  }
}

/** Drops the oldest intents past the cap so an unreachable target cannot grow the store. Runs over
 *  the whole target rather than the arriving id, because the cap is what bounds the target. */
function capPendingKillsForTarget(
  leases: SshRemotePtyLease[],
  targetId: string,
  now: number
): void {
  const scoped = leases.filter((lease) => lease.targetId === targetId && lease.pendingKill)
  if (scoped.length <= MAX_SSH_PENDING_PTY_KILLS_PER_TARGET) {
    return
  }
  const kept = new Set(
    prunePendingSshPtyKills(pendingSshPtyKillEntries(scoped), now).map((entry) => entry.ptyId)
  )
  for (const lease of scoped) {
    if (!kept.has(lease.ptyId)) {
      delete lease.pendingKill
      lease.updatedAt = now
    }
  }
}

/** Records a stop this client asked for and could not confirm.
 *
 *  Creates the lease when none exists — a kill that found no provider registered writes no lease of
 *  its own, and that offline close is the case most likely to strand a remote process. It is
 *  created `terminated`, carrying no pane identity, because the user closed this PTY: reattach must
 *  not adopt it. That is a routing tombstone and not a claim the process died — the process
 *  question is exactly what `pendingKill` is now tracking, and the replay reads every lease state. */
export function recordSshRemotePtyKillIntent(
  operations: SshPtyLeaseOperations,
  targetId: string,
  ptyId: string,
  intent: SshPendingPtyKill
): void {
  const relayPtyId = operations.toStoredPtyId(targetId, ptyId)
  const now = intent.requestedAt
  operations.state.sshRemotePtyLeases ??= []
  const leases = operations.state.sshRemotePtyLeases
  const existing = leases.find((entry) => entry.targetId === targetId && entry.ptyId === relayPtyId)
  if (existing) {
    // Why keep the earliest requestedAt: the TTL bounds how long the intent may chase the host, and
    // a repeated close must not extend it. Attempts carry over so replays stay countable.
    existing.pendingKill = {
      ...intent,
      requestedAt: Math.min(existing.pendingKill?.requestedAt ?? now, now),
      attempts: existing.pendingKill?.attempts ?? intent.attempts
    }
    existing.updatedAt = now
  } else {
    leases.push({
      targetId,
      ptyId: relayPtyId,
      state: 'terminated',
      createdAt: now,
      updatedAt: now,
      pendingKill: intent
    })
  }
  capPendingKillsForTarget(leases, targetId, now)
  operations.flush()
}

/** Retires the intent. Deliberately does not touch `state`: the caller decides whether it earned a
 *  `terminated` tombstone, because only some retirement paths observed the host. */
export function clearSshRemotePtyKillIntent(
  operations: SshPtyLeaseOperations,
  targetId: string,
  ptyId: string
): void {
  const relayPtyId = operations.toStoredPtyId(targetId, ptyId)
  const lease = (operations.state.sshRemotePtyLeases ?? []).find(
    (entry) => entry.targetId === targetId && entry.ptyId === relayPtyId
  )
  if (!lease?.pendingKill) {
    return
  }
  delete lease.pendingKill
  lease.updatedAt = Date.now()
  operations.flush()
}

/** Counts one replay against the intent so a target that never answers stays visible in the record
 *  without changing what it is allowed to do. */
export function noteSshRemotePtyKillReplayAttempt(
  operations: SshPtyLeaseOperations,
  targetId: string,
  ptyId: string
): void {
  const relayPtyId = operations.toStoredPtyId(targetId, ptyId)
  const lease = (operations.state.sshRemotePtyLeases ?? []).find(
    (entry) => entry.targetId === targetId && entry.ptyId === relayPtyId
  )
  if (!lease?.pendingKill) {
    return
  }
  lease.pendingKill = { ...lease.pendingKill, attempts: lease.pendingKill.attempts + 1 }
  lease.updatedAt = Date.now()
  operations.flush()
}
