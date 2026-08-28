import type { DispatchContextRow, WorkerDispatchRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { ensureMutationReceiptCapacity } from '../../mutation-receipt-capacity'
import { CURRENT_CONTRACT_VERSION } from '../contract-constants'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'
import { insertStartingDispatchContextRow } from '../dispatch-row-writer'
import type { DispatchCreator } from '../dispatch-depth'

export function createStartingWorkerDispatch(
  this: OrchestrationDb,
  params: {
    taskId: string
    startOptions: unknown
    launchTokenHash?: string
    retryOf?: string
    runtimeEpoch?: string
    federation?: {
      environmentId: string
      environmentName: string
      peerFingerprint: string
      protocolVersion: number
    }
    mutationReceipt?: {
      callerFingerprint: string
      requestId: string
      method: string
      payloadHash: string
    }
    /** Who is dispatching, for nesting depth. Required so a new caller must decide. */
    creator: DispatchCreator
    maxDepth: number
  }
): { dispatch: DispatchContextRow; worker: WorkerDispatchRow } {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    if (params.mutationReceipt) {
      const receipt = params.mutationReceipt
      const existing = this.getMutationReceipt(receipt.callerFingerprint, receipt.requestId)
      if (existing) {
        if (existing.method !== receipt.method || existing.payload_hash !== receipt.payloadHash) {
          throw new OrchestrationError(
            'request_mismatch',
            `Mutation request ${receipt.requestId} was already used with different input.`
          )
        }
        throw new OrchestrationError(
          'operation_unknown',
          `Mutation ${receipt.requestId} already has a durable acceptance record.`
        )
      }
      ensureMutationReceiptCapacity(this.db)
      this.db
        .prepare(
          `INSERT INTO mutation_receipts (
             caller_fingerprint, request_id, method, payload_hash, state
           ) VALUES (?, ?, ?, ?, 'pending')`
        )
        .run(receipt.callerFingerprint, receipt.requestId, receipt.method, receipt.payloadHash)
    }
    const task = this.getTask(params.taskId)
    if (!task) {
      throw new OrchestrationError('task_not_found', `Task ${params.taskId} was not found.`)
    }
    if (params.retryOf) {
      const prior = this.getDispatchContextById(params.retryOf)
      const priorWorker = this.getWorkerDispatch(params.retryOf)
      const latest = this.getDispatchContext(task.id)
      if (
        !prior ||
        prior.task_id !== task.id ||
        latest?.id !== prior.id ||
        !priorWorker ||
        !['failed', 'stopped', 'abandoned'].includes(priorWorker.state) ||
        !['failed', 'blocked'].includes(task.status)
      ) {
        throw new OrchestrationError(
          'task_not_startable',
          `Task ${task.id} cannot retry from Dispatch ${params.retryOf}.`
        )
      }
    } else if (task.status !== 'ready') {
      throw new OrchestrationError(
        'task_not_startable',
        `Task ${task.id} is ${task.status}; only a ready Task can start.`
      )
    }

    const id = generateId('ctx')
    if (params.mutationReceipt) {
      this.db
        .prepare(
          `UPDATE mutation_receipts
           SET receipt = ?, updated_at = datetime('now')
           WHERE caller_fingerprint = ? AND request_id = ? AND state = 'pending'`
        )
        .run(
          JSON.stringify({ accepted: { dispatchId: id } }),
          params.mutationReceipt.callerFingerprint,
          params.mutationReceipt.requestId
        )
    }
    insertStartingDispatchContextRow(this.db, {
      id,
      runId: task.run_id,
      taskId: task.id,
      contractVersion: CURRENT_CONTRACT_VERSION,
      launchTokenHash: params.launchTokenHash ?? null,
      depth: this.resolveChildDispatchDepth(params.creator, params.maxDepth)
    })
    this.db
      .prepare(
        `INSERT INTO worker_dispatches (
           dispatch_id, runtime_epoch, state, stage, start_options
         ) VALUES (?, ?, 'starting', 'accepted', ?)`
      )
      .run(id, params.runtimeEpoch ?? null, JSON.stringify(params.startOptions))
    if (params.federation) {
      this.db
        .prepare(
          `INSERT INTO federated_dispatches (
             dispatch_id, environment_id, environment_name, peer_fingerprint, protocol_version
           ) VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          id,
          params.federation.environmentId,
          params.federation.environmentName,
          params.federation.peerFingerprint,
          params.federation.protocolVersion
        )
    }
    this.db
      .prepare(
        "UPDATE tasks SET status = 'dispatched', result = NULL, completed_at = NULL WHERE id = ?"
      )
      .run(task.id)
    this.db.exec('COMMIT')
    this.hasAnyDispatchContextsCache = true
    return {
      dispatch: this.getDispatchContextById(id) as DispatchContextRow,
      worker: this.getWorkerDispatch(id) as WorkerDispatchRow
    }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type WorkerDispatchStartMethods = {
  createStartingWorkerDispatch: typeof createStartingWorkerDispatch
}

export function attachWorkerDispatchStart(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createStartingWorkerDispatch
  })
}
