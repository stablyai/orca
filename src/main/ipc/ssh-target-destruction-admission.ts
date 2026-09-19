import { isRuntimeOwnedSshTarget } from '../ssh/ssh-connection-store'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { OrcadOutgoingPreparationStore } from '../ssh/orcad-outgoing-preparation-store'
import { assertSshResetAdmissionAllowed } from './ssh-reset-production-state'

export function assertManualSshTargetDestructionAllowed(targetId: string): void {
  assertSshResetAdmissionAllowed(targetId)
  assertSshTargetNotManagedOrPreparing(targetId)
}

export function assertSshTargetNotManagedOrPreparing(targetId: string): void {
  const target = getSshTargetRegistryStore()?.getTarget(targetId)
  if (target && (isRuntimeOwnedSshTarget(target) || target.orcadProvisioning)) {
    throw new Error(
      'Managed runtime SSH targets must be managed through their runtime environment.'
    )
  }
  const preparations = new OrcadOutgoingPreparationStore(getCanonicalUserDataPath()).list()
  if (preparations.some((entry) => entry.sourceSshTargetId === targetId)) {
    throw new Error('orcad_outgoing_preparation_reconciliation_required')
  }
}
