import type { MaestroTerminalLeaseObservation } from '../../../../../shared/maestro-terminal-lease'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

export function recordMaestroProviderRollover(
  db: OrchestrationDb,
  leaseId: string,
  reason: MaestroTerminalLeaseObservation
): void {
  const lease = db.getMaestroTerminalLease(leaseId)
  if (!lease) {
    throw new OrchestrationError('lease_not_found', `Terminal lease ${leaseId} was not found.`)
  }
  db.retainMaestroTerminalLease(lease.id)
  db.transitionMaestroTerminalLease({
    leaseId: lease.id,
    state: 'outcome_unknown',
    observation: reason
  })
}
