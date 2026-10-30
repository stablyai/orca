import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SshPendingPtyKill } from '../../../shared/ssh-pending-pty-kill'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import type { PtyRetirementEvidence } from '../../pty-exit-proof'
import { invalidateLocalWorktreeMetadataPruneInputs } from '../../local-worktree-metadata-prune-gate'
import { pruneRetiredSshRemotePtyLeaseTombstones } from './ssh-pty-lease-tombstone-retention'

// Only relay-era profiles contain leases; this build retires existing records without creating more.
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

/** Terminated means explicit close or proven exit; route loss remains expired and preserves bindings. */
export function markSshRemotePtyLease(
  operations: SshPtyLeaseOperations,
  targetId: string,
  ptyId: string,
  // Require typed retirement evidence even though this writer does not inspect it.
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
  // Scrub bindings before removing newly unreachable tombstones.
  const tombstonesPruned = pruneRetiredSshRemotePtyLeaseTombstones(operations, targetId)
  if (stateChanged || bindingsCleared || tombstonesPruned) {
    operations.flush()
  }
}

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
    // Removing the last lease may release a metadata ownership claim.
    invalidateLocalWorktreeMetadataPruneInputs()
    operations.flush()
  }
}
