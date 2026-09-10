import type {
  MaestroTerminalLaunchProfile,
  MaestroTerminalLease,
  MaestroTerminalLeaseRole,
  MaestroTerminalRetentionPolicy
} from '../../../../../shared/maestro-terminal-lease'
import { OrchestrationError } from '../../orchestration-error'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'
import {
  attachMaestroTerminalLease,
  rebindCurrentCoordinatorLease,
  retainMaestroTerminalLease,
  transitionMaestroTerminalLease
} from './maestro-terminal-lease-lifecycle-store'
import {
  deserializeMaestroTerminalLease,
  getMaestroTerminalLeaseRow,
  type MaestroTerminalLeaseRow
} from './maestro-terminal-lease-row'
import {
  getMaestroWorkerLeaseTransferReceipt,
  getMaestroWorkerLeaseTransferReceiptByMutationRequest
} from './maestro-terminal-lease-transfer-receipt'
import { transferMaestroWorkerTerminalLease } from './maestro-terminal-lease-transfer-store'

export {
  attachMaestroTerminalLease,
  rebindCurrentCoordinatorLease,
  retainMaestroTerminalLease,
  transitionMaestroTerminalLease
} from './maestro-terminal-lease-lifecycle-store'
export {
  getMaestroWorkerLeaseTransferReceipt,
  getMaestroWorkerLeaseTransferReceiptByMutationRequest
} from './maestro-terminal-lease-transfer-receipt'
export { transferMaestroWorkerTerminalLease } from './maestro-terminal-lease-transfer-store'

export type ReserveMaestroTerminalLeaseParams = {
  requestId: string
  executionHostId: string
  workspaceKey: string
  runId: string
  taskId?: string | null
  attemptId?: string | null
  coordinatorGeneration?: number | null
  role: MaestroTerminalLeaseRole
  workerTerminalResourceId?: string | null
  coordinatorRunId?: string | null
  title: string
  launchProfile: MaestroTerminalLaunchProfile
  parentLeaseId?: string | null
  spawnedBy: string
  ownerPrincipal: string
  retentionPolicy: MaestroTerminalRetentionPolicy
  capsuleDigest?: string | null
}

export function getMaestroTerminalLease(
  this: OrchestrationDb,
  leaseId: string
): MaestroTerminalLease | undefined {
  const row = getMaestroTerminalLeaseRow(this, 'id', leaseId)
  return row ? deserializeMaestroTerminalLease(row) : undefined
}

export function getMaestroTerminalLeaseByRequest(
  this: OrchestrationDb,
  requestId: string
): MaestroTerminalLease | undefined {
  const row = getMaestroTerminalLeaseRow(this, 'request_id', requestId)
  return row ? deserializeMaestroTerminalLease(row) : undefined
}

export function getMaestroTerminalLeaseByHandle(
  this: OrchestrationDb,
  terminalHandle: string
): MaestroTerminalLease | undefined {
  const row = this.db
    .prepare(
      `SELECT * FROM maestro_terminal_leases
       WHERE terminal_handle = ? AND lifecycle_state NOT IN ('released', 'superseded', 'archived')
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(terminalHandle) as MaestroTerminalLeaseRow | undefined
  return row ? deserializeMaestroTerminalLease(row) : undefined
}

export function getMaestroTerminalLeaseByTab(
  this: OrchestrationDb,
  executionHostId: string,
  workspaceKey: string,
  tabId: string,
  ptyIncarnation: string
): MaestroTerminalLease | undefined {
  const row = this.db
    .prepare(
      `SELECT * FROM maestro_terminal_leases
       WHERE execution_host_id = ? AND workspace_key = ? AND tab_id = ? AND pty_incarnation = ?
         AND lifecycle_state NOT IN ('released', 'superseded', 'archived')
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(executionHostId, workspaceKey, tabId, ptyIncarnation) as
    | MaestroTerminalLeaseRow
    | undefined
  return row ? deserializeMaestroTerminalLease(row) : undefined
}

export function getCoordinatorLease(
  this: OrchestrationDb,
  runId: string,
  generation: number
): MaestroTerminalLease | undefined {
  const row = this.db
    .prepare(
      `SELECT * FROM maestro_terminal_leases
       WHERE run_id = ? AND coordinator_generation = ? AND role = 'coordinator'`
    )
    .get(runId, generation) as MaestroTerminalLeaseRow | undefined
  return row ? deserializeMaestroTerminalLease(row) : undefined
}

export function getMaestroTerminalLeaseByWorkerResource(
  this: OrchestrationDb,
  workerTerminalResourceId: string
): MaestroTerminalLease | undefined {
  const row = getMaestroTerminalLeaseRow(
    this,
    'worker_terminal_resource_id',
    workerTerminalResourceId
  )
  return row ? deserializeMaestroTerminalLease(row) : undefined
}

export function reserveMaestroTerminalLease(
  this: OrchestrationDb,
  params: ReserveMaestroTerminalLeaseParams
): MaestroTerminalLease {
  if (params.role === 'worker' && !params.attemptId) {
    throw new OrchestrationError(
      'lease_identity_conflict',
      'Worker terminal leases require attemptId.'
    )
  }
  const existing = this.getMaestroTerminalLeaseByRequest(params.requestId)
  if (existing) {
    if (
      existing.runId !== params.runId ||
      existing.role !== params.role ||
      existing.coordinatorGeneration !== (params.coordinatorGeneration ?? null) ||
      existing.taskId !== (params.taskId ?? null) ||
      existing.attemptId !== (params.attemptId ?? null)
    ) {
      throw new OrchestrationError(
        'mutation_conflict',
        `Terminal lease request ${params.requestId} is already bound to another owner.`
      )
    }
    return existing
  }
  const id = generateId('mtl')
  this.db
    .prepare(
      `INSERT INTO maestro_terminal_leases (
        id, request_id, execution_host_id, workspace_key, run_id, task_id, attempt_id,
        coordinator_generation, role, worker_terminal_resource_id, coordinator_run_id,
        title, launch_profile_json, parent_lease_id, spawned_by, owner_principal,
        retention_policy, lifecycle_state, capsule_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)`
    )
    .run(
      id,
      params.requestId,
      params.executionHostId,
      params.workspaceKey,
      params.runId,
      params.taskId ?? null,
      params.attemptId ?? null,
      params.coordinatorGeneration ?? null,
      params.role,
      params.workerTerminalResourceId ?? null,
      params.coordinatorRunId ?? null,
      params.title,
      JSON.stringify(params.launchProfile),
      params.parentLeaseId ?? null,
      params.spawnedBy,
      params.ownerPrincipal,
      params.retentionPolicy,
      params.capsuleDigest ?? null
    )
  return this.getMaestroTerminalLease(id) as MaestroTerminalLease
}

export type MaestroTerminalLeaseStoreMethods = {
  getMaestroTerminalLease: typeof getMaestroTerminalLease
  getMaestroTerminalLeaseByRequest: typeof getMaestroTerminalLeaseByRequest
  getMaestroTerminalLeaseByHandle: typeof getMaestroTerminalLeaseByHandle
  getMaestroTerminalLeaseByTab: typeof getMaestroTerminalLeaseByTab
  getCoordinatorLease: typeof getCoordinatorLease
  getMaestroTerminalLeaseByWorkerResource: typeof getMaestroTerminalLeaseByWorkerResource
  getMaestroWorkerLeaseTransferReceipt: typeof getMaestroWorkerLeaseTransferReceipt
  getMaestroWorkerLeaseTransferReceiptByMutationRequest: typeof getMaestroWorkerLeaseTransferReceiptByMutationRequest
  reserveMaestroTerminalLease: typeof reserveMaestroTerminalLease
  attachMaestroTerminalLease: typeof attachMaestroTerminalLease
  rebindCurrentCoordinatorLease: typeof rebindCurrentCoordinatorLease
  transitionMaestroTerminalLease: typeof transitionMaestroTerminalLease
  retainMaestroTerminalLease: typeof retainMaestroTerminalLease
  transferMaestroWorkerTerminalLease: typeof transferMaestroWorkerTerminalLease
}

export function attachMaestroTerminalLeaseStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getMaestroTerminalLease,
    getMaestroTerminalLeaseByRequest,
    getMaestroTerminalLeaseByHandle,
    getMaestroTerminalLeaseByTab,
    getCoordinatorLease,
    getMaestroTerminalLeaseByWorkerResource,
    getMaestroWorkerLeaseTransferReceipt,
    getMaestroWorkerLeaseTransferReceiptByMutationRequest,
    reserveMaestroTerminalLease,
    attachMaestroTerminalLease,
    rebindCurrentCoordinatorLease,
    transitionMaestroTerminalLease,
    retainMaestroTerminalLease,
    transferMaestroWorkerTerminalLease
  })
}
