import type { RemovedSshTargetTombstone, SshTarget } from '../../../shared/ssh-types'
import {
  type SshTargetStateOperations,
  addClaudeLivePtySessionId as addClaudeLivePtySessionIdOperation,
  addDeletedSshConfigAlias as addDeletedSshConfigAliasOperation,
  addRemovedSshTargetTombstone as addRemovedSshTargetTombstoneOperation,
  addSshTarget as addSshTargetOperation,
  clearDeletedSshConfigAliases as clearDeletedSshConfigAliasesOperation,
  getClaudeLivePtySessionIds as getClaudeLivePtySessionIdsOperation,
  getDeletedSshConfigAliases as getDeletedSshConfigAliasesOperation,
  getRemovedSshTargetTombstones as getRemovedSshTargetTombstonesOperation,
  getSshTarget as getSshTargetOperation,
  getSshTargets as getSshTargetsOperation,
  removeClaudeLivePtySessionId as removeClaudeLivePtySessionIdOperation,
  removeDeletedSshConfigAlias as removeDeletedSshConfigAliasOperation,
  removeRemovedSshTargetTombstone as removeRemovedSshTargetTombstoneOperation,
  releaseRemovedSshTargetTombstone as releaseRemovedSshTargetTombstoneOperation,
  removeSshTarget as removeSshTargetOperation,
  updateSshTarget as updateSshTargetOperation
} from '../leasing-ssh-ptys/ssh-target-state'
import {
  reassignSshTargetId as reassignSshTargetIdOperation,
  type SshTargetReassignmentOperations
} from '../leasing-ssh-ptys/ssh-target-reassignment'
import { allocateSshTargetGeneration as allocateSshTargetGenerationOperation } from '../scheduling-automations/automation-owner-projection'

import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import type { WriteFlushBarrierOperations } from './write-flush-barriers'
import type { RepoLifecycleOperations } from './repo-lifecycle-operations'
import { syncProjectHostSetupCompatibilityState } from './repo-lifecycle-operations'
import { scheduleSave } from './write-scheduling'

type SshProfileOperationsRuntime = Pick<StoreRuntimeState, 'protectedSecrets' | 'state'>

const sshProfileOperationsContext = Symbol('SshProfileOperations')
type SshProfileOperationsContext = {
  runtime: SshProfileOperationsRuntime
  scheduling: WriteSchedulingOperations
  flushBarriers: WriteFlushBarrierOperations
  repos: RepoLifecycleOperations
}

export class SshProfileOperations {
  readonly [sshProfileOperationsContext]: SshProfileOperationsContext

  constructor(
    runtime: SshProfileOperationsRuntime,
    scheduling: WriteSchedulingOperations,
    flushBarriers: WriteFlushBarrierOperations,
    repos: RepoLifecycleOperations
  ) {
    this[sshProfileOperationsContext] = { runtime, scheduling, flushBarriers, repos }
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
    removeSshTargetOperation(getSshTargetStateOperations(this), id)
  }

  allocateSshTargetGeneration(): number {
    const context = this[sshProfileOperationsContext]
    return allocateSshTargetGenerationOperation(context.runtime.state, () =>
      scheduleSave(context.scheduling)
    )
  }

  getClaudeLivePtySessionIds(): string[] {
    return getClaudeLivePtySessionIdsOperation(this[sshProfileOperationsContext].runtime.state)
  }

  addClaudeLivePtySessionId(sessionId: string): void {
    addClaudeLivePtySessionIdOperation(getSshTargetStateOperations(this), sessionId)
  }

  removeClaudeLivePtySessionId(sessionId: string): void {
    removeClaudeLivePtySessionIdOperation(getSshTargetStateOperations(this), sessionId)
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
      scheduleSave: () => scheduleSave(this[sshProfileOperationsContext].scheduling)
    }
    return reassignSshTargetIdOperation(operations, oldTargetId, newTargetId)
  }
}

export function getSshTargetStateOperations(owner: SshProfileOperations): SshTargetStateOperations {
  return {
    state: owner[sshProfileOperationsContext].runtime.state,
    protectedSecrets: owner[sshProfileOperationsContext].runtime.protectedSecrets,
    scheduleSave: () => scheduleSave(owner[sshProfileOperationsContext].scheduling),
    flush: () => owner[sshProfileOperationsContext].flushBarriers.flush()
  }
}

export function installSshProfileOperationsContext(
  target: object,
  source: SshProfileOperations
): void {
  Object.defineProperty(target, sshProfileOperationsContext, {
    value: source[sshProfileOperationsContext]
  })
}
