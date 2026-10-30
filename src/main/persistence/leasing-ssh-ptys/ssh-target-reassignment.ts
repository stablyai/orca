import type { ProjectHostSetup } from '../../../shared/project-types'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  migrateFolderWorkspaceHostSshTargetId,
  migrateUiHostScopeSshTargetId,
  migrateWorkspaceSessionSshTargetId
} from '../../ssh/targets/ssh-target-id-migration'
import type { ProtectedSecretPersistence } from '../../protected-secret-persistence'
import { sshPtyOwnerLeaseSecretSlot } from '../../protected-secret-persistence'
import {
  migrateRetirementNamespaceHostIdentity,
  sshHostIdentity
} from '../../worktree-retirement-namespace'
import {
  migrateAutomationHostFilterSshTargetId,
  migrateAutomationsForSshReadoption
} from '../../automations/automation-ssh-readoption-migration'
import { automationIdsPinnedToSshTarget } from '../scheduling-automations/automation-owner-projection'
import { reassignCanonicalWorktreeMetadataHost } from './canonical-worktree-host-reassignment'

export type SshTargetReassignmentOperations = {
  state: PersistedState
  protectedSecrets: Pick<ProtectedSecretPersistence, 'removeRetainedBlob'>
  syncProjectHostSetupCompatibilityState: () => void
  scheduleSave: () => void
}

/** Copy endpoint history but move obsolete row-ID namespaces after target rotation. */
function migrateRetirementNamespaces(
  state: PersistedState,
  oldTargetId: string,
  newTargetId: string
): boolean {
  const newTarget = state.sshTargets.find((target) => target.id === newTargetId)
  if (!newTarget) {
    return false
  }
  const tombstone = state.removedSshTargetTombstones?.find(
    (entry) => entry.oldTargetId === oldTargetId
  )
  return migrateRetirementNamespaceHostIdentity(state.retiredWorktreeNamesByNamespace, {
    // Removed row IDs have no remaining owner.
    moveFrom: [toSshExecutionHostId(oldTargetId)],
    // Another target may still use the old endpoint; retain its history.
    copyFrom: tombstone ? [sshHostIdentity(tombstone)] : [],
    to: sshHostIdentity(newTarget)
  })
}

/** Reassign removed-target carriers to the replacement target so workspaces can reattach. */
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
    // Unstamped legacy repos derive host identity from connectionId.
    if (matchesHost) {
      repo.executionHostId = newHostId
    }
    repoIds.add(repo.id)
  }
  // Recover canonical-only metadata before rewriting locator aliases.
  const identityResult = reassignCanonicalWorktreeMetadataHost(
    operations.state,
    oldHostId,
    newHostId
  )
  let metaChanged = false
  for (const [worktreeId, meta] of Object.entries(operations.state.worktreeMeta)) {
    if (meta.hostId === oldHostId && !identityResult.preservedWorktreeIds.has(worktreeId)) {
      meta.hostId = newHostId
      metaChanged = true
    }
  }
  // Stale carrier IDs otherwise cause SSH target not found on later use.
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
  // Host-keyed partitions follow the new ID; existing destinations win.
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
  const workspacePinnedAutomationIds = automationIdsPinnedToSshTarget(operations.state, oldTargetId)
  if (migrateFolderWorkspaceHostSshTargetId(operations.state, oldTargetId, newTargetId)) {
    carrierChanged = true
  }
  if (
    migrateAutomationsForSshReadoption({
      automations: operations.state.automations ?? [],
      automationRuns: operations.state.automationRuns ?? [],
      oldTargetId,
      newTargetId,
      workspacePinnedAutomationIds,
      newTargetGeneration: (operations.state.sshTargets ?? []).find(
        (target) => target.id === newTargetId
      )?.generation
    })
  ) {
    carrierChanged = true
  }
  if (migrateAutomationHostFilterSshTargetId(operations.state.ui, oldTargetId, newTargetId)) {
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
  // Only repo/setup edits affect host-setup compatibility.
  if (repoIds.size > 0 || setupsChanged) {
    operations.syncProjectHostSetupCompatibilityState()
  }
  if (
    repoIds.size > 0 ||
    metaChanged ||
    carrierChanged ||
    setupsChanged ||
    identityResult.changed
  ) {
    // Publish new array identities so cached lists see the in-place ownership rewrites.
    operations.state.repos = [...operations.state.repos]
    operations.state.automations = [...(operations.state.automations ?? [])]
    operations.state.automationRuns = [...(operations.state.automationRuns ?? [])]
    operations.scheduleSave()
  }
  return [...repoIds]
}
