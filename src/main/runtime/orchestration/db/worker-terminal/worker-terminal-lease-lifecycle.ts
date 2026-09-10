import type { MaestroTerminalLeaseState } from '../../../../../shared/maestro-terminal-lease'
import { normalizeExecutionHostId } from '../../../../../shared/execution-host'
import { parsePtyStopReceipt } from '../../../../../shared/pty-stop-receipt'
import type { OrchestrationDb } from '../orchestration-db'

function linkedLease(db: OrchestrationDb, resourceId: string) {
  return db.getMaestroTerminalLeaseByWorkerResource(resourceId)
}

function transitionIf(
  db: OrchestrationDb,
  resourceId: string,
  from: readonly MaestroTerminalLeaseState[],
  to: MaestroTerminalLeaseState
): void {
  const lease = linkedLease(db, resourceId)
  if (lease && from.includes(lease.lifecycleState)) {
    db.transitionMaestroTerminalLease({ leaseId: lease.id, state: to })
  }
}

export function markLinkedWorkerLeaseReleasePending(db: OrchestrationDb, resourceId: string): void {
  transitionIf(db, resourceId, ['ready', 'active', 'input_required'], 'settled')
  transitionIf(db, resourceId, ['settled', 'retained', 'outcome_unknown'], 'release_pending')
}

export function markLinkedWorkerLeaseReleased(db: OrchestrationDb, resourceId: string): void {
  markLinkedWorkerLeaseReleasePending(db, resourceId)
  const lease = linkedLease(db, resourceId)
  if (!lease || lease.lifecycleState !== 'release_pending') {
    return
  }
  db.transitionMaestroTerminalLease({
    leaseId: lease.id,
    state: hasExactCleanupReceipt(lease) ? 'released' : 'outcome_unknown'
  })
}

export function markLinkedWorkerLeaseReleaseUnknown(db: OrchestrationDb, resourceId: string): void {
  transitionIf(db, resourceId, ['release_pending'], 'outcome_unknown')
}

export function retainLinkedWorkerLease(db: OrchestrationDb, resourceId: string): void {
  const lease = linkedLease(db, resourceId)
  if (lease && !['released', 'archived'].includes(lease.lifecycleState)) {
    db.retainMaestroTerminalLease(lease.id)
  }
}

function hasExactCleanupReceipt(
  lease: NonNullable<ReturnType<OrchestrationDb['getMaestroTerminalLease']>>
): boolean {
  const receipt = lease.cleanupReceipt
  const providerReceipt = receipt?.providerStopReceipt
  const executionHostId = normalizeExecutionHostId(lease.executionHostId)
  if (
    receipt?.verdict !== 'exited' ||
    !receipt.processTreeVerified ||
    !providerReceipt ||
    !executionHostId ||
    !lease.terminalHandle ||
    !lease.ptyIncarnation
  ) {
    return false
  }
  try {
    const parsed = parsePtyStopReceipt(providerReceipt, {
      executionHostId,
      terminalHandle: lease.terminalHandle,
      ...(lease.processRootId ? { ptyId: lease.processRootId } : {}),
      ptyIncarnation: lease.ptyIncarnation
    })
    return parsed.verdict === 'exited' && parsed.processTreeVerified
  } catch {
    return false
  }
}
