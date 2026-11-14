import type { RemovedSshTargetTombstone, SshTarget } from '../../../../shared/ssh-types'
import { WORKSPACE_SESSION_DOMAINS } from '../../workspace-session-domains'
import { WORKTREE_METADATA_DOMAINS } from '../../profile-save-domains'
import {
  type SshTargetStateOperations,
  addDeletedSshConfigAlias as addDeletedSshConfigAliasOperation,
  addRemovedSshTargetTombstone as addRemovedSshTargetTombstoneOperation,
  addSshTarget as addSshTargetOperation,
  clearDeletedSshConfigAliases as clearDeletedSshConfigAliasesOperation,
  getDeletedSshConfigAliases as getDeletedSshConfigAliasesOperation,
  getRemovedSshTargetTombstones as getRemovedSshTargetTombstonesOperation,
  getSshTarget as getSshTargetOperation,
  getSshTargets as getSshTargetsOperation,
  removeDeletedSshConfigAlias as removeDeletedSshConfigAliasOperation,
  removeRemovedSshTargetTombstone as removeRemovedSshTargetTombstoneOperation,
  releaseRemovedSshTargetTombstone as releaseRemovedSshTargetTombstoneOperation,
  removeSshTarget as removeSshTargetOperation,
  updateSshTarget as updateSshTargetOperation
} from '../../leasing-ssh-ptys/ssh-target-state'
import {
  reassignSshTargetId as reassignSshTargetIdOperation,
  type SshTargetReassignmentOperations
} from '../../leasing-ssh-ptys/ssh-target-reassignment'
import { allocateSshTargetGeneration as allocateSshTargetGenerationOperation } from '../../scheduling-automations/automation-owner-projection'

import type { StoreRuntimeState } from '../store-runtime-state'
import type { WriteSchedulingOperations } from '../profile-writing/write-scheduling'
import type { RepoLifecycleOperations } from '../project-catalog/repo-lifecycle-operations'
import { syncProjectHostSetupCompatibilityState } from '../project-catalog/repo-lifecycle-operations'
import { scheduleSave } from '../profile-writing/write-scheduling'
import { forgetSshConnectionGeneration } from '../../../ssh/connection/authority/ssh-connection-generation'

type SshProfileOperationsRuntime = Pick<StoreRuntimeState, 'protectedSecrets' | 'state'>

const sshProfileOperationsContext = Symbol('SshProfileOperations')
type SshProfileOperationsContext = {
  runtime: SshProfileOperationsRuntime
  scheduling: WriteSchedulingOperations
  repos: RepoLifecycleOperations
}

/** Re-adopting an SSH target rewrites every record that names the old target. */
const SSH_TARGET_REASSIGNMENT_DOMAINS = [
  'repos',
  'projects',
  'projectHostSetups',
  ...WORKTREE_METADATA_DOMAINS,
  ...WORKSPACE_SESSION_DOMAINS,
  'ui',
  'retiredWorktreeNamesByNamespace',
  'folderWorkspaces',
  'projectGroups',
  'automations',
  'automationRuns',
  'sshRemotePtyLeases',
  'sshPtyConsumerRecoveries'
]

export class SshProfileOperations {
  readonly [sshProfileOperationsContext]: SshProfileOperationsContext

  constructor(
    runtime: SshProfileOperationsRuntime,
    scheduling: WriteSchedulingOperations,
    repos: RepoLifecycleOperations
  ) {
    this[sshProfileOperationsContext] = { runtime, scheduling, repos }
  }

  getSshTargets(): SshTarget[] {
    return getSshTargetsOperation(this[sshProfileOperationsContext].runtime.state)
  }

  getSshTarget(id: string): SshTarget | undefined {
    return getSshTargetOperation(this[sshProfileOperationsContext].runtime.state, id)
  }

  addSshTarget(target: SshTarget): void {
    addSshTargetOperation(getSshTargetStateOperations(this), target)
  }

  updateSshTarget(id: string, updates: Partial<Omit<SshTarget, 'id'>>): SshTarget | null {
    return updateSshTargetOperation(getSshTargetStateOperations(this), id, updates)
  }

  removeSshTarget(id: string): void {
    const existed = this.getSshTarget(id) !== undefined
    removeSshTargetOperation(getSshTargetStateOperations(this), id)
    if (existed) {
      forgetSshConnectionGeneration(id)
    }
  }

  allocateSshTargetGeneration(): number {
    const context = this[sshProfileOperationsContext]
    return allocateSshTargetGenerationOperation(context.runtime.state, () =>
      scheduleSave(context.scheduling, ['sshTargetGenerationCounter'])
    )
  }

  getDeletedSshConfigAliases(): string[] {
    return getDeletedSshConfigAliasesOperation(this[sshProfileOperationsContext].runtime.state)
  }

  addDeletedSshConfigAlias(alias: string): void {
    addDeletedSshConfigAliasOperation(getSshTargetStateOperations(this), alias)
  }

  removeDeletedSshConfigAlias(alias: string): void {
    removeDeletedSshConfigAliasOperation(getSshTargetStateOperations(this), alias)
  }

  clearDeletedSshConfigAliases(): void {
    clearDeletedSshConfigAliasesOperation(getSshTargetStateOperations(this))
  }

  getRemovedSshTargetTombstones(): RemovedSshTargetTombstone[] {
    return getRemovedSshTargetTombstonesOperation(this[sshProfileOperationsContext].runtime.state)
  }

  addRemovedSshTargetTombstone(tombstone: RemovedSshTargetTombstone): void {
    addRemovedSshTargetTombstoneOperation(getSshTargetStateOperations(this), tombstone)
  }

  releaseRemovedSshTargetTombstone(oldTargetId: string): void {
    releaseRemovedSshTargetTombstoneOperation(getSshTargetStateOperations(this), oldTargetId)
  }

  removeRemovedSshTargetTombstone(oldTargetId: string): void {
    removeRemovedSshTargetTombstoneOperation(getSshTargetStateOperations(this), oldTargetId)
  }

  reassignSshTargetId(oldTargetId: string, newTargetId: string): string[] {
    const operations: SshTargetReassignmentOperations = {
      state: this[sshProfileOperationsContext].runtime.state,
      protectedSecrets: this[sshProfileOperationsContext].runtime.protectedSecrets,
      syncProjectHostSetupCompatibilityState: () =>
        syncProjectHostSetupCompatibilityState(this[sshProfileOperationsContext].repos),
      scheduleSave: () =>
        scheduleSave(this[sshProfileOperationsContext].scheduling, SSH_TARGET_REASSIGNMENT_DOMAINS)
    }
    return reassignSshTargetIdOperation(operations, oldTargetId, newTargetId)
  }
}

export function getSshTargetStateOperations(owner: SshProfileOperations): SshTargetStateOperations {
  return {
    state: owner[sshProfileOperationsContext].runtime.state,
    protectedSecrets: owner[sshProfileOperationsContext].runtime.protectedSecrets,
    scheduleSave: (domains) => scheduleSave(owner[sshProfileOperationsContext].scheduling, domains)
  }
}
