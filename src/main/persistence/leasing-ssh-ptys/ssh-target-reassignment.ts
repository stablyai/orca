import type { ProjectHostSetup } from '../../../shared/project-types'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  migrateUiHostScopeSshTargetId,
  migrateWorkspaceSessionSshTargetId
} from '../../ssh/ssh-target-id-migration'
import type { ProtectedSecretPersistence } from '../../protected-secret-persistence'
import { sshPtyOwnerLeaseSecretSlot } from '../../protected-secret-persistence'
import {
  migrateRetirementNamespaceHostIdentity,
  sshHostIdentity
} from '../../worktree-retirement-namespace'

export type SshTargetReassignmentOperations = {
  state: PersistedState
  protectedSecrets: Pick<ProtectedSecretPersistence, 'removeRetainedBlob'>
  syncProjectHostSetupCompatibilityState: () => void
  scheduleSave: () => void
}

/** Retirement namespaces key on the endpoint a target reaches, so a rotation moves them only when
 *  the endpoint itself changed — plus any pre-identity key that embedded the row id. */
function migrateRetirementNamespaces(
  state: PersistedState,
  oldTargetId: string,
  newTargetId: string
): boolean {
  const newTarget = state.sshTargets.find((target) => target.id === newTargetId)
  if (!newTarget) {
    return false
  }
  // The removal tombstone is the only record of what endpoint the old id reached.
  const tombstone = state.removedSshTargetTombstones?.find(
    (entry) => entry.oldTargetId === oldTargetId
  )
  return migrateRetirementNamespaceHostIdentity(state.retiredWorktreeNamesByNamespace, {
    // The row id died with the target, so nothing else can still resolve to it.
    moveFrom: [toSshExecutionHostId(oldTargetId)],
    // Endpoints are shared, not owned: a second target can still reach this host, so leave its
    // bucket in place rather than stripping the tombstones out from under it.
    copyFrom: tombstone ? [sshHostIdentity(tombstone)] : [],
    to: sshHostIdentity(newTarget)
  })
}

/**
 * Re-point every repo and worktree meta pinned to a removed SSH target id onto
 * a re-added target's id so orphaned workspaces reattach. Returns re-pointed repo ids.
 */
export function reassignSshTargetId(
  operations: SshTargetReassignmentOperations,
  oldTargetId: string,
  newTargetId: string
): string[] {
  if (oldTargetId === newTargetId) {
    return []
  }
  const oldHostId = toSshExecutionHostId(oldTargetId)
  const newHostId = toSshExecutionHostId(newTargetId)
  const repoIds = new Set<string>()
  for (const repo of operations.state.repos) {
    const matchesConnection = repo.connectionId === oldTargetId
    const matchesHost = repo.executionHostId === oldHostId
    if (!matchesConnection && !matchesHost) {
      continue
    }
    if (matchesConnection) {
      repo.connectionId = newTargetId
    }
    // Why: don't stamp executionHostId where it was unset — addRemoteRepoFromPath repos derive the host from connectionId.
    if (matchesHost) {
      repo.executionHostId = newHostId
    }
    repoIds.add(repo.id)
  }
  // Re-point worktree metas whose hostId pointed at the old SSH host.
  let metaChanged = false
  for (const meta of Object.values(operations.state.worktreeMeta)) {
    if (meta.hostId === oldHostId) {
      meta.hostId = newHostId
      metaChanged = true
    }
  }
  // Why: any carrier still holding the old id later throws `SSH target not found` (STA-1468); migrate them all.
  let carrierChanged = migrateWorkspaceSessionSshTargetId(
    operations.state.workspaceSession,
    oldTargetId,
    newTargetId
  )
  for (const session of Object.values(operations.state.workspaceSessionsByHostId ?? {})) {
    if (session && migrateWorkspaceSessionSshTargetId(session, oldTargetId, newTargetId)) {
      carrierChanged = true
    }
  }
  // Why: partitions are read by host id; re-key from the removed id to the new one (keep new if it already exists).
  const partitions = operations.state.workspaceSessionsByHostId
  const oldPartition = partitions?.[oldHostId]
  if (partitions && oldPartition) {
    delete partitions[oldHostId]
    partitions[newHostId] ??= oldPartition
    carrierChanged = true
  }
  if (migrateUiHostScopeSshTargetId(operations.state.ui, oldTargetId, newTargetId)) {
    carrierChanged = true
  }
  if (migrateRetirementNamespaces(operations.state, oldTargetId, newTargetId)) {
    carrierChanged = true
  }
  for (const lease of operations.state.sshRemotePtyLeases ?? []) {
    if (lease.targetId === oldTargetId) {
      lease.targetId = newTargetId
      carrierChanged = true
    }
  }
  const recoveries = operations.state.sshPtyConsumerRecoveries ?? []
  const retainedRecoveries = recoveries.filter((record) => record.targetId !== oldTargetId)
  if (retainedRecoveries.length !== recoveries.length) {
    operations.state.sshPtyConsumerRecoveries = retainedRecoveries
    operations.protectedSecrets.removeRetainedBlob(sshPtyOwnerLeaseSecretSlot(oldTargetId))
    carrierChanged = true
  }
  let setupsChanged = false
  const keptSetups: ProjectHostSetup[] = []
  for (const setup of operations.state.projectHostSetups) {
    if (setup.hostId !== oldHostId) {
      keptSetups.push(setup)
      continue
    }
    const duplicate = operations.state.projectHostSetups.some(
      (entry) =>
        entry !== setup && entry.projectId === setup.projectId && entry.hostId === newHostId
    )
    // Why: drop the old ghost row that would violate (projectId, hostId) uniqueness with the re-added host's setup.
    if (duplicate) {
      setupsChanged = true
      continue
    }
    setup.hostId = newHostId
    setup.updatedAt = Date.now()
    keptSetups.push(setup)
    setupsChanged = true
  }
  if (setupsChanged) {
    operations.state.projectHostSetups = keptSetups
  }
  // Why: repo-row and host-setup rewrites affect host-setup compatibility; meta-only rewrites don't, so gate the sync here.
  if (repoIds.size > 0 || setupsChanged) {
    operations.syncProjectHostSetupCompatibilityState()
  }
  if (repoIds.size > 0 || metaChanged || carrierChanged || setupsChanged) {
    operations.scheduleSave()
  }
  return [...repoIds]
}
