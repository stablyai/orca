import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SshPendingPtyKill } from '../../../shared/ssh-pending-pty-kill'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import type { PtyRetirementEvidence } from '../../pty-exit-proof'
import { invalidateLocalWorktreeMetadataPruneInputs } from '../../local-worktree-metadata-prune-gate'
import { pruneRetiredSshRemotePtyLeaseTombstones } from './ssh-pty-lease-tombstone-retention'

// Leases come only from relay-era profiles; this build retires them and never creates new ones.
export type SshPtyLeaseOperations = {
  state: PersistedState
  toStoredPtyId: (targetId: string, ptyId: string) => string
  toComparablePtyId: (targetId: string, ptyId: string) => string
  clearBindingsForTarget: (targetId: string) => void
  clearBindingsForLeases: (targetId: string, leases: SshRemotePtyLease[]) => boolean
  flush: () => void
}

export function getSshRemotePtyLeases(
  state: PersistedState,
  targetId?: string
): SshRemotePtyLease[] {
  const leases = state.sshRemotePtyLeases ?? []
  return leases.filter((lease) => targetId === undefined || lease.targetId === targetId)
}

/** Writes `terminated`, the only state written now: an operator close or a proven exit, which
 *  unbinds the pane. `expired` would say the client lost its route and must keep the binding. */
export function markSshRemotePtyLease(
  operations: SshPtyLeaseOperations,
  targetId: string,
  ptyId: string,
  // Why unread: the type makes each retirement name its evidence (src/main/pty-exit-proof.ts).
  _evidence: PtyRetirementEvidence
): void {
  const state = 'terminated'
  const relayPtyId = operations.toStoredPtyId(targetId, ptyId)
  const lease = operations.state.sshRemotePtyLeases?.find(
    (entry) => entry.targetId === targetId && entry.ptyId === relayPtyId
  )
  if (!lease) {
    return
  }
  const stateChanged = lease.state !== state
  if (stateChanged) {
    lease.state = state
    lease.updatedAt = Date.now()
  }
  const bindingsCleared = operations.clearBindingsForLeases(targetId, [lease])
  // Why after the scrub: it is the scrub that makes the tombstones unreachable.
  const tombstonesPruned = pruneRetiredSshRemotePtyLeaseTombstones(operations, targetId)
  if (stateChanged || bindingsCleared || tombstonesPruned) {
    operations.flush()
  }
}

/** The legacy relay bridge's record of a closed tab's undelivered stop; null clears it. */
export function setSshRemotePtyLeasePendingKill(
  operations: SshPtyLeaseOperations,
  targetId: string,
  ptyId: string,
  pendingKill: SshPendingPtyKill | null
): void {
  const relayPtyId = operations.toStoredPtyId(targetId, ptyId)
  const lease = operations.state.sshRemotePtyLeases?.find(
    (entry) => entry.targetId === targetId && entry.ptyId === relayPtyId
  )
  if (!lease || (!pendingKill && !lease.pendingKill)) {
    return
  }
  if (pendingKill) {
    lease.pendingKill = pendingKill
  } else {
    delete lease.pendingKill
  }
  lease.updatedAt = Date.now()
  operations.flush()
}

export function removeSshRemotePtyLeases(
  operations: SshPtyLeaseOperations,
  targetId: string
): void {
  operations.state.sshRemotePtyLeases ??= []
  operations.clearBindingsForTarget(targetId)
  const before = operations.state.sshRemotePtyLeases.length
  operations.state.sshRemotePtyLeases = operations.state.sshRemotePtyLeases.filter(
    (lease) => lease.targetId !== targetId
  )
  if (operations.state.sshRemotePtyLeases.length !== before) {
    // Why: the leases may have been the last claim on dangling metadata rows (#17775).
    invalidateLocalWorktreeMetadataPruneInputs()
    operations.flush()
  }
}
