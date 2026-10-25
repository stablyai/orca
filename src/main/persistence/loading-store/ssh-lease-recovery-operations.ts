import type { SshPendingPtyKill } from '../../../shared/ssh-pending-pty-kill'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import type { PtyRetirementEvidence } from '../../pty-exit-proof'
import {
  getSshRemotePtyLeases as getSshRemotePtyLeasesOperation,
  markSshRemotePtyLease as markSshRemotePtyLeaseOperation,
  removeSshRemotePtyLeases as removeSshRemotePtyLeasesOperation,
  setSshRemotePtyLeasePendingKill as setSshRemotePtyLeasePendingKillOperation,
  type SshPtyLeaseOperations
} from '../leasing-ssh-ptys/ssh-pty-lease-operations'
import {
  clearSshRemotePtyBindingsForLeases as clearSshRemotePtyBindingsForLeasesOperation,
  clearSshRemotePtyBindingsForTarget as clearSshRemotePtyBindingsForTargetOperation,
  type SshPtyBindingCleanupOperations
} from '../leasing-ssh-ptys/ssh-pty-binding-cleanup'

import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteFlushBarrierOperations } from './write-flush-barriers'
import type { TerminalBindingRecoveryOperations } from './terminal-binding-recovery'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'

type SshLeaseRecoveryOperationsRuntime = Pick<
  StoreRuntimeState,
  'dirtyProfileStateDomains' | 'state'
>

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

  getSshRemotePtyLeases(targetId?: string): SshRemotePtyLease[] {
    return getSshRemotePtyLeasesOperation(
      this[sshLeaseRecoveryOperationsContext].runtime.state,
      targetId
    )
  }

  markSshRemotePtyLease(targetId: string, ptyId: string, evidence: PtyRetirementEvidence): void {
    markSshRemotePtyLeaseOperation(getSshPtyLeaseOperations(this), targetId, ptyId, evidence)
  }

  setSshRemotePtyLeasePendingKill(
    targetId: string,
    ptyId: string,
    pendingKill: SshPendingPtyKill | null
  ): void {
    setSshRemotePtyLeasePendingKillOperation(
      getSshPtyLeaseOperations(this),
      targetId,
      ptyId,
      pendingKill
    )
  }

  removeSshRemotePtyLeases(targetId: string): void {
    removeSshRemotePtyLeasesOperation(getSshPtyLeaseOperations(this), targetId)
  }
}

function getSshPtyBindingCleanupOperations(
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

function getSshPtyLeaseOperations(owner: SshLeaseRecoveryOperations): SshPtyLeaseOperations {
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
    flush: () => {
      owner[sshLeaseRecoveryOperationsContext].runtime.dirtyProfileStateDomains?.add(
        'sshRemotePtyLeases'
      )
      owner[sshLeaseRecoveryOperationsContext].flushBarriers.flush()
    }
  }
}
