import type {
  SshPendingPtyKill,
  SshPendingPtyKillEntry
} from '../../../shared/ssh-pending-pty-kill'
import type { SshPtyConsumerRecovery, SshRemotePtyLease } from '../../../shared/ssh-types'
import {
  clearSshRemotePtyKillIntent as clearSshRemotePtyKillIntentOperation,
  getSshRemotePtyKillIntents as getSshRemotePtyKillIntentsOperation,
  noteSshRemotePtyKillReplayAttempt as noteSshRemotePtyKillReplayAttemptOperation,
  pruneExpiredSshRemotePtyKillIntents as pruneExpiredSshRemotePtyKillIntentsOperation,
  recordSshRemotePtyKillIntent as recordSshRemotePtyKillIntentOperation
} from '../leasing-ssh-ptys/ssh-pty-kill-intent-operations'
import {
  getSshRemotePtyLeases as getSshRemotePtyLeasesOperation,
  markSshRemotePtyLease as markSshRemotePtyLeaseOperation,
  markSshRemotePtyLeases as markSshRemotePtyLeasesOperation,
  markSshRemotePtyLeasesAsync as markSshRemotePtyLeasesAsyncOperation,
  markSshRemotePtyLeasesAttachedAsync as markSshRemotePtyLeasesAttachedAsyncOperation,
  markSshRemotePtyLeasesForShutdown as markSshRemotePtyLeasesForShutdownOperation,
  removeSshRemotePtyLease as removeSshRemotePtyLeaseOperation,
  removeSshRemotePtyLeases as removeSshRemotePtyLeasesOperation,
  type SshPtyLeaseOperations,
  upsertSshRemotePtyLease as upsertSshRemotePtyLeaseOperation
} from '../leasing-ssh-ptys/ssh-pty-lease-operations'
import {
  getSshPtyConsumerRecovery as getSshPtyConsumerRecoveryOperation,
  removeSshPtyConsumerRecovery as removeSshPtyConsumerRecoveryOperation,
  type SshPtyConsumerRecoveryOperations,
  upsertSshPtyConsumerRecovery as upsertSshPtyConsumerRecoveryOperation
} from '../leasing-ssh-ptys/ssh-pty-consumer-recovery'
import {
  clearSshRemotePtyBindingsForLeases as clearSshRemotePtyBindingsForLeasesOperation,
  clearSshRemotePtyBindingsForTarget as clearSshRemotePtyBindingsForTargetOperation,
  type SshPtyBindingCleanupOperations
} from '../leasing-ssh-ptys/ssh-pty-binding-cleanup'

import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteFlushBarrierOperations } from './write-flush-barriers'
import type { TerminalBindingRecoveryOperations } from './terminal-binding-recovery'
import type { WriteSchedulingOperations } from './write-scheduling'
import { flushDurableStateOrThrowAsync } from './write-flush-barriers'
import { scheduleSave } from './write-scheduling'

type SshLeaseRecoveryOperationsRuntime = Pick<StoreRuntimeState, 'protectedSecrets' | 'state'>

const sshLeaseRecoveryOperationsContext = Symbol('SshLeaseRecoveryOperations')
type SshLeaseRecoveryOperationsContext = {
  runtime: SshLeaseRecoveryOperationsRuntime
  flushBarriers: WriteFlushBarrierOperations
  bindingRecovery: TerminalBindingRecoveryOperations
  scheduling: WriteSchedulingOperations
}

export class SshLeaseRecoveryOperations {
  readonly [sshLeaseRecoveryOperationsContext]: SshLeaseRecoveryOperationsContext

  constructor(
    runtime: SshLeaseRecoveryOperationsRuntime,
    flushBarriers: WriteFlushBarrierOperations,
    bindingRecovery: TerminalBindingRecoveryOperations,
    scheduling: WriteSchedulingOperations
  ) {
    this[sshLeaseRecoveryOperationsContext] = {
      runtime,
      flushBarriers,
      bindingRecovery,
      scheduling
    }
  }

  getSshPtyConsumerRecovery(targetId: string): SshPtyConsumerRecovery | null {
    return getSshPtyConsumerRecoveryOperation(getSshPtyConsumerRecoveryOperations(this), targetId)
  }

  async upsertSshPtyConsumerRecovery(record: SshPtyConsumerRecovery): Promise<void> {
    await upsertSshPtyConsumerRecoveryOperation(getSshPtyConsumerRecoveryOperations(this), record)
  }

  async removeSshPtyConsumerRecovery(targetId: string): Promise<void> {
    await removeSshPtyConsumerRecoveryOperation(getSshPtyConsumerRecoveryOperations(this), targetId)
  }

  getSshRemotePtyLeases(targetId?: string): SshRemotePtyLease[] {
    return getSshRemotePtyLeasesOperation(
      this[sshLeaseRecoveryOperationsContext].runtime.state,
      targetId
    )
  }

  upsertSshRemotePtyLease(
    lease: Omit<SshRemotePtyLease, 'createdAt' | 'updatedAt'> &
      Partial<Pick<SshRemotePtyLease, 'createdAt' | 'updatedAt'>>
  ): void {
    upsertSshRemotePtyLeaseOperation(getSshPtyLeaseOperations(this), lease)
  }

  markSshRemotePtyLeases(targetId: string, state: SshRemotePtyLease['state']): void {
    markSshRemotePtyLeasesOperation(getSshPtyLeaseOperations(this), targetId, state)
  }

  markSshRemotePtyLeasesForShutdown(targetId: string, state: SshRemotePtyLease['state']): void {
    markSshRemotePtyLeasesForShutdownOperation(getSshPtyLeaseOperations(this), targetId, state)
  }

  async markSshRemotePtyLeasesAsync(
    targetId: string,
    state: SshRemotePtyLease['state']
  ): Promise<void> {
    await markSshRemotePtyLeasesAsyncOperation(getSshPtyLeaseOperations(this), targetId, state)
  }

  async markSshRemotePtyLeasesAttachedAsync(
    targetId: string,
    ptyIds: readonly string[]
  ): Promise<void> {
    await markSshRemotePtyLeasesAttachedAsyncOperation(
      getSshPtyLeaseOperations(this),
      targetId,
      ptyIds
    )
  }

  markSshRemotePtyLease(targetId: string, ptyId: string, state: SshRemotePtyLease['state']): void {
    markSshRemotePtyLeaseOperation(getSshPtyLeaseOperations(this), targetId, ptyId, state)
  }

  removeSshRemotePtyLease(targetId: string, ptyId: string): void {
    removeSshRemotePtyLeaseOperation(getSshPtyLeaseOperations(this), targetId, ptyId)
  }

  removeSshRemotePtyLeases(targetId: string): void {
    removeSshRemotePtyLeasesOperation(getSshPtyLeaseOperations(this), targetId)
  }

  getSshRemotePtyKillIntents(targetId: string, now = Date.now()): SshPendingPtyKillEntry[] {
    return getSshRemotePtyKillIntentsOperation(
      this[sshLeaseRecoveryOperationsContext].runtime.state,
      targetId,
      now
    )
  }

  recordSshRemotePtyKillIntent(targetId: string, ptyId: string, intent: SshPendingPtyKill): void {
    recordSshRemotePtyKillIntentOperation(getSshPtyLeaseOperations(this), targetId, ptyId, intent)
  }

  clearSshRemotePtyKillIntent(targetId: string, ptyId: string): void {
    clearSshRemotePtyKillIntentOperation(getSshPtyLeaseOperations(this), targetId, ptyId)
  }

  noteSshRemotePtyKillReplayAttempt(targetId: string, ptyId: string): void {
    noteSshRemotePtyKillReplayAttemptOperation(getSshPtyLeaseOperations(this), targetId, ptyId)
  }

  pruneExpiredSshRemotePtyKillIntents(targetId: string, now = Date.now()): void {
    pruneExpiredSshRemotePtyKillIntentsOperation(getSshPtyLeaseOperations(this), targetId, now)
  }
}

export function getSshPtyConsumerRecoveryOperations(
  owner: SshLeaseRecoveryOperations
): SshPtyConsumerRecoveryOperations {
  return {
    state: owner[sshLeaseRecoveryOperationsContext].runtime.state,
    protectedSecrets: owner[sshLeaseRecoveryOperationsContext].runtime.protectedSecrets,
    flushDurableStateOrThrowAsync: () =>
      flushDurableStateOrThrowAsync(owner[sshLeaseRecoveryOperationsContext].flushBarriers)
  }
}

export function getSshPtyBindingCleanupOperations(
  owner: SshLeaseRecoveryOperations
): SshPtyBindingCleanupOperations {
  return {
    state: owner[sshLeaseRecoveryOperationsContext].runtime.state,
    toComparablePtyId: (targetId, ptyId) =>
      owner[sshLeaseRecoveryOperationsContext].bindingRecovery.getRelayPtyIdForSshLeaseComparison(
        targetId,
        ptyId
      ),
    scheduleSave: () => scheduleSave(owner[sshLeaseRecoveryOperationsContext].scheduling)
  }
}

export function getSshPtyLeaseOperations(owner: SshLeaseRecoveryOperations): SshPtyLeaseOperations {
  return {
    state: owner[sshLeaseRecoveryOperationsContext].runtime.state,
    toStoredPtyId: (targetId, ptyId) =>
      owner[sshLeaseRecoveryOperationsContext].bindingRecovery.getRelayPtyIdForSshLeaseStorage(
        targetId,
        ptyId
      ),
    toComparablePtyId: (targetId, ptyId) =>
      owner[sshLeaseRecoveryOperationsContext].bindingRecovery.getRelayPtyIdForSshLeaseComparison(
        targetId,
        ptyId
      ),
    clearBindingsForTarget: (targetId) =>
      clearSshRemotePtyBindingsForTargetOperation(
        getSshPtyBindingCleanupOperations(owner),
        targetId
      ),
    clearBindingsForLeases: (targetId, leases) =>
      clearSshRemotePtyBindingsForLeasesOperation(
        getSshPtyBindingCleanupOperations(owner),
        targetId,
        leases
      ),
    flush: () => owner[sshLeaseRecoveryOperationsContext].flushBarriers.flush(),
    flushDurableStateOrThrowAsync: () =>
      flushDurableStateOrThrowAsync(owner[sshLeaseRecoveryOperationsContext].flushBarriers)
  }
}

export function installSshLeaseRecoveryOperationsContext(
  target: object,
  source: SshLeaseRecoveryOperations
): void {
  Object.defineProperty(target, sshLeaseRecoveryOperationsContext, {
    value: source[sshLeaseRecoveryOperationsContext]
  })
}
