import {
  canTransitionMaestroTerminalLease,
  type MaestroTerminalCleanupReceipt,
  type MaestroTerminalLease,
  type MaestroTerminalLeaseObservation,
  type MaestroTerminalLeaseState
} from '../../../../../shared/maestro-terminal-lease'
import { OrchestrationError } from '../../orchestration-error'
import { isEquivalentPaneKey } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'
import { findLiveTerminalLeaseOwner } from './maestro-terminal-lease-row'

export function attachMaestroTerminalLease(
  this: OrchestrationDb,
  params: {
    leaseId: string
    terminalHandle: string
    tabId: string | null
    paneKey: string | null
    ptyIncarnation: string
    processRootId: string | null
    providerSessionId?: string | null
    executionHostId?: string
    workspaceKey?: string
    workerTerminalResourceId?: string | null
  }
): MaestroTerminalLease {
  const lease = this.getMaestroTerminalLease(params.leaseId)
  if (!lease) {
    throw new OrchestrationError(
      'lease_not_found',
      `Terminal lease ${params.leaseId} was not found.`
    )
  }
  if (lease.terminalHandle) {
    if (
      lease.terminalHandle !== params.terminalHandle ||
      lease.ptyIncarnation !== params.ptyIncarnation
    ) {
      throw new OrchestrationError(
        'lease_identity_conflict',
        `Terminal lease ${params.leaseId} already owns another terminal incarnation.`
      )
    }
    return lease
  }
  const conflictingOwner = findLiveTerminalLeaseOwner(this, {
    leaseId: params.leaseId,
    executionHostId: params.executionHostId ?? lease.executionHostId,
    workspaceKey: params.workspaceKey ?? lease.workspaceKey,
    terminalHandle: params.terminalHandle,
    ptyIncarnation: params.ptyIncarnation
  })
  if (conflictingOwner) {
    throw new OrchestrationError(
      'lease_identity_conflict',
      `Terminal incarnation is already owned by lease ${conflictingOwner.id}.`
    )
  }
  if (!canTransitionMaestroTerminalLease(lease.lifecycleState, 'starting')) {
    throw new OrchestrationError('lease_state_conflict', `Lease ${params.leaseId} cannot start.`)
  }
  this.db
    .prepare(
      `UPDATE maestro_terminal_leases
       SET terminal_handle = ?, tab_id = ?, pane_key = ?, pty_incarnation = ?,
           process_root_id = ?, provider_session_id = ?, execution_host_id = COALESCE(?, execution_host_id),
           workspace_key = COALESCE(?, workspace_key),
           worker_terminal_resource_id = COALESCE(?, worker_terminal_resource_id),
           lifecycle_state = 'starting', updated_at = datetime('now')
       WHERE id = ? AND terminal_handle IS NULL`
    )
    .run(
      params.terminalHandle,
      params.tabId,
      params.paneKey,
      params.ptyIncarnation,
      params.processRootId,
      params.providerSessionId ?? null,
      params.executionHostId ?? null,
      params.workspaceKey ?? null,
      params.workerTerminalResourceId ?? null,
      params.leaseId
    )
  return this.getMaestroTerminalLease(params.leaseId) as MaestroTerminalLease
}

export function transitionMaestroTerminalLease(
  this: OrchestrationDb,
  params: {
    leaseId: string
    state: MaestroTerminalLeaseState
    observation?: MaestroTerminalLeaseObservation | null
    cleanupReceipt?: MaestroTerminalCleanupReceipt | null
    archivedTail?: string | null
  }
): MaestroTerminalLease {
  const lease = this.getMaestroTerminalLease(params.leaseId)
  if (!lease) {
    throw new OrchestrationError(
      'lease_not_found',
      `Terminal lease ${params.leaseId} was not found.`
    )
  }
  if (!canTransitionMaestroTerminalLease(lease.lifecycleState, params.state)) {
    throw new OrchestrationError(
      'lease_state_conflict',
      `Terminal lease ${params.leaseId} cannot move from ${lease.lifecycleState} to ${params.state}.`
    )
  }
  const archivedTail = params.archivedTail?.slice(-8_192) ?? lease.archivedTail
  this.db
    .prepare(
      `UPDATE maestro_terminal_leases
       SET lifecycle_state = ?, observation = COALESCE(?, observation),
           cleanup_receipt_json = COALESCE(?, cleanup_receipt_json), archived_tail = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(
      params.state,
      params.observation ?? null,
      params.cleanupReceipt ? JSON.stringify(params.cleanupReceipt) : null,
      archivedTail,
      params.leaseId
    )
  return this.getMaestroTerminalLease(params.leaseId) as MaestroTerminalLease
}

export function retainMaestroTerminalLease(
  this: OrchestrationDb,
  leaseId: string
): MaestroTerminalLease {
  this.db
    .prepare(
      `UPDATE maestro_terminal_leases
       SET retention_policy = 'retain', lifecycle_state = 'retained', updated_at = datetime('now')
       WHERE id = ? AND lifecycle_state NOT IN ('released', 'superseded', 'archived')`
    )
    .run(leaseId)
  const lease = this.getMaestroTerminalLease(leaseId)
  if (!lease) {
    throw new OrchestrationError('lease_not_found', `Terminal lease ${leaseId} was not found.`)
  }
  return lease
}

export function rebindCurrentCoordinatorLease(
  this: OrchestrationDb,
  params: {
    leaseId: string
    executionHostId: string
    workspaceKey: string
    terminalHandle: string
    tabId: string | null
    paneKey: string
    ptyIncarnation: string
    processRootId: string | null
  }
): MaestroTerminalLease {
  const lease = this.getMaestroTerminalLease(params.leaseId)
  const run = lease ? this.getRun(lease.runId) : undefined
  if (
    !lease ||
    lease.role !== 'coordinator' ||
    lease.coordinatorGeneration === null ||
    !run ||
    run.consumer_generation !== lease.coordinatorGeneration ||
    run.coordinator_handle !== params.terminalHandle ||
    !run.coordinator_pane_key ||
    !isEquivalentPaneKey(run.coordinator_pane_key, params.paneKey)
  ) {
    throw new OrchestrationError(
      'consumer_fenced',
      'Only the current Run coordinator may rebind its terminal lease.'
    )
  }
  const conflictingOwner = findLiveTerminalLeaseOwner(this, {
    leaseId: lease.id,
    executionHostId: params.executionHostId,
    workspaceKey: params.workspaceKey,
    terminalHandle: params.terminalHandle,
    ptyIncarnation: params.ptyIncarnation
  })
  if (conflictingOwner) {
    throw new OrchestrationError(
      'lease_identity_conflict',
      `Terminal incarnation is already owned by lease ${conflictingOwner.id}.`
    )
  }
  this.db
    .prepare(
      `UPDATE maestro_terminal_leases
       SET execution_host_id = ?, workspace_key = ?, terminal_handle = ?, tab_id = ?,
           pane_key = ?, pty_incarnation = ?, process_root_id = ?,
           retention_policy = 'retain', lifecycle_state = 'retained', observation = NULL,
           cleanup_receipt_json = NULL, updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(
      params.executionHostId,
      params.workspaceKey,
      params.terminalHandle,
      params.tabId,
      params.paneKey,
      params.ptyIncarnation,
      params.processRootId,
      params.leaseId
    )
  return this.getMaestroTerminalLease(params.leaseId) as MaestroTerminalLease
}
