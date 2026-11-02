import type { PersistedState } from '../../../shared/persisted-state-types'
import type { RemovedSshTargetTombstone, SshTarget } from '../../../shared/ssh-types'
import type { ProtectedSecretPersistence } from '../../protected-secret-persistence'
import { sshPtyOwnerLeaseSecretSlot } from '../../protected-secret-persistence'
import {
  MAX_REMOVED_SSH_TARGET_TOMBSTONES,
  capRemovedSshTargetTombstones,
  collectSshTargetRemovalEvidenceDependencies
} from '../../ssh/targets/removed-ssh-target-tombstone-retention'
import { normalizeSshTarget } from './ssh-normalization'
import { isRuntimeOwnedSshTargetId } from '../../../shared/execution-host'
import {
  migrateRetirementNamespaceHostIdentity,
  sshHostIdentity
} from '../../worktree-retirement-namespace'

export type SshTargetStateOperations = {
  state: PersistedState
  protectedSecrets: Pick<ProtectedSecretPersistence, 'removeRetainedBlob'>
  scheduleSave: () => void
}

export function getSshTargets(state: PersistedState): SshTarget[] {
  return (state.sshTargets ?? []).map(normalizeSshTarget)
}

export function getSshTarget(state: PersistedState, id: string): SshTarget | undefined {
  const target = state.sshTargets?.find((entry) => entry.id === id)
  return target ? normalizeSshTarget(target) : undefined
}

export function addSshTarget(operations: SshTargetStateOperations, target: SshTarget): void {
  // Replace the array to invalidate identity-cached automation projections.
  operations.state.sshTargets = [...(operations.state.sshTargets ?? []), normalizeSshTarget(target)]
  operations.scheduleSave()
}

export function updateSshTarget(
  operations: SshTargetStateOperations,
  id: string,
  updates: Partial<Omit<SshTarget, 'id'>>
): SshTarget | null {
  const target = operations.state.sshTargets?.find((entry) => entry.id === id)
  if (!target) {
    return null
  }
  const normalized = normalizeSshTarget({ ...target, ...updates })
  const previousHostIdentity = sshHostIdentity(target)
  // Object.assign cannot remove fields discarded by normalization.
  const mutableTarget = target as Record<string, unknown>
  for (const key of Object.keys(mutableTarget)) {
    if (!Object.hasOwn(normalized, key)) {
      delete mutableTarget[key]
    }
  }
  Object.assign(target, normalized)
  // Endpoint edits bypass readoption; copy history because other targets may still use the old endpoint.
  // Skip disposable runtimes: their new filesystems share no history, and per-run buckets evict real tombstones.
  if (!isRuntimeOwnedSshTargetId(id)) {
    migrateRetirementNamespaceHostIdentity(operations.state.retiredWorktreeNamesByNamespace, {
      copyFrom: [previousHostIdentity],
      to: sshHostIdentity(target)
    })
  }
  // Invalidate identity-cached lists after mutating the shared row.
  operations.state.sshTargets = [...(operations.state.sshTargets ?? [])]
  operations.scheduleSave()
  return { ...target }
}

export function removeSshTarget(operations: SshTargetStateOperations, id: string): void {
  const targets = operations.state.sshTargets ?? []
  const recoveries = operations.state.sshPtyConsumerRecoveries ?? []
  const nextTargets = targets.filter((target) => target.id !== id)
  const nextRecoveries = recoveries.filter((record) => record.targetId !== id)
  if (nextTargets.length === targets.length && nextRecoveries.length === recoveries.length) {
    return
  }
  operations.state.sshTargets = nextTargets
  operations.state.sshPtyConsumerRecoveries = nextRecoveries
  operations.protectedSecrets.removeRetainedBlob(sshPtyOwnerLeaseSecretSlot(id))
  operations.scheduleSave()
}

export function getDeletedSshConfigAliases(state: PersistedState): string[] {
  return [...(state.deletedSshConfigAliases ?? [])]
}

export function addDeletedSshConfigAlias(
  operations: SshTargetStateOperations,
  alias: string
): void {
  operations.state.deletedSshConfigAliases ??= []
  if (!operations.state.deletedSshConfigAliases.includes(alias)) {
    operations.state.deletedSshConfigAliases.push(alias)
    operations.scheduleSave()
  }
}

export function removeDeletedSshConfigAlias(
  operations: SshTargetStateOperations,
  alias: string
): void {
  const current = operations.state.deletedSshConfigAliases
  if (!current || !current.includes(alias)) {
    return
  }
  operations.state.deletedSshConfigAliases = current.filter((entry) => entry !== alias)
  operations.scheduleSave()
}

export function clearDeletedSshConfigAliases(operations: SshTargetStateOperations): void {
  if (
    operations.state.deletedSshConfigAliases &&
    operations.state.deletedSshConfigAliases.length > 0
  ) {
    operations.state.deletedSshConfigAliases = []
    operations.scheduleSave()
  }
}

export function getRemovedSshTargetTombstones(state: PersistedState): RemovedSshTargetTombstone[] {
  return [...(state.removedSshTargetTombstones ?? [])]
}

export function addRemovedSshTargetTombstone(
  operations: SshTargetStateOperations,
  tombstone: RemovedSshTargetTombstone
): void {
  const existing = operations.state.removedSshTargetTombstones ?? []
  const filtered = existing.filter((entry) => entry.oldTargetId !== tombstone.oldTargetId)
  operations.state.removedSshTargetTombstones = capRemovedSshTargetTombstones(
    [...filtered, tombstone],
    sshTargetRemovalEvidenceDependencies(operations.state),
    MAX_REMOVED_SSH_TARGET_TOMBSTONES
  )
  operations.scheduleSave()
}

function sshTargetRemovalEvidenceDependencies(state: PersistedState): Set<string> {
  return collectSshTargetRemovalEvidenceDependencies({
    automations: state.automations ?? [],
    automationHostFilter: state.ui?.automationHostFilter,
    workspaceState: {
      folderWorkspaces: state.folderWorkspaces ?? [],
      projectGroups: state.projectGroups ?? [],
      repos: state.repos ?? []
    }
  })
}

export function releaseRemovedSshTargetTombstone(
  operations: SshTargetStateOperations,
  oldTargetId: string
): void {
  if (!sshTargetRemovalEvidenceDependencies(operations.state).has(oldTargetId)) {
    removeRemovedSshTargetTombstone(operations, oldTargetId)
  }
}

export function removeRemovedSshTargetTombstone(
  operations: SshTargetStateOperations,
  oldTargetId: string
): void {
  const existing = operations.state.removedSshTargetTombstones
  if (!existing?.some((entry) => entry.oldTargetId === oldTargetId)) {
    return
  }
  operations.state.removedSshTargetTombstones = existing.filter(
    (entry) => entry.oldTargetId !== oldTargetId
  )
  operations.scheduleSave()
}
