import type { DispatchContextRow, WorkerDispatchRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { ensureMutationReceiptCapacity } from '../../mutation-receipt-capacity'
import { CURRENT_CONTRACT_VERSION } from '../contract-constants'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'
import { insertStartingDispatchContextRow } from '../dispatch-row-writer'
import type { DispatchCreator } from '../dispatch-depth'

type IntakeManifestOutcome = {
  outcomeId?: unknown
  target?: unknown
  dependencies?: unknown
}

/** Re-check batch scheduling authority under the SAME BEGIN IMMEDIATE lock
 * that creates the Dispatch. The earlier admission check is useful feedback,
 * but two conflicting starts can both pass a read-only check; only this locked
 * check makes "serialize" operational. */
function assertAtomicOutcomeStartAllowed(
  db: OrchestrationDb,
  task: { id: string; run_id: string },
  startOptions: unknown
): void {
  const outcome = db.db
    .prepare(
      `SELECT outcome_id, intake_batch FROM control_plane_outcomes
       WHERE run_id = ?`
    )
    .get(task.run_id) as { outcome_id: string; intake_batch: string | null } | undefined
  if (!outcome?.intake_batch) {
    return
  }

  const manifestRow = db.db
    .prepare(
      `SELECT manifest_json FROM control_plane_intake_manifests
       WHERE batch_id = ?`
    )
    .get(outcome.intake_batch) as { manifest_json: string } | undefined
  let manifestOutcome: IntakeManifestOutcome | undefined
  try {
    const parsed = JSON.parse(manifestRow?.manifest_json ?? '') as {
      outcomes?: IntakeManifestOutcome[]
    }
    manifestOutcome = parsed.outcomes?.find(
      (candidate) => candidate.outcomeId === outcome.outcome_id
    )
  } catch {
    manifestOutcome = undefined
  }
  if (!manifestOutcome || !Array.isArray(manifestOutcome.dependencies)) {
    throw new OrchestrationError(
      'outcome_manifest_unreadable',
      `Outcome ${outcome.outcome_id} has no readable immutable intake manifest.`
    )
  }

  const options =
    startOptions && typeof startOptions === 'object'
      ? (startOptions as Record<string, unknown>)
      : {}
  const expectedTarget =
    typeof manifestOutcome.target === 'string' ? manifestOutcome.target.replace(/^id:/, '') : null
  const actualTarget =
    typeof options.resolvedWorktreeId === 'string'
      ? options.resolvedWorktreeId.replace(/^id:/, '')
      : null
  if (!expectedTarget || !actualTarget || expectedTarget !== actualTarget) {
    throw new OrchestrationError(
      'outcome_target_mismatch',
      `Outcome ${outcome.outcome_id} is bound to ${expectedTarget ?? '<unreadable>'}, not ${actualTarget ?? '<unresolved>'}.`
    )
  }

  for (const dependencyId of manifestOutcome.dependencies) {
    if (typeof dependencyId !== 'string') {
      throw new OrchestrationError(
        'outcome_manifest_unreadable',
        `Outcome ${outcome.outcome_id} has a malformed dependency.`
      )
    }
    const dependency = db.db
      .prepare('SELECT status FROM control_plane_outcomes WHERE outcome_id = ?')
      .get(dependencyId) as { status: string } | undefined
    if (dependency?.status !== 'closed') {
      throw new OrchestrationError(
        'outcome_dependency_unsettled',
        `Outcome ${outcome.outcome_id} depends on ${dependencyId}, which is not settled.`
      )
    }
  }

  const relations = db.db
    .prepare(
      `SELECT left_outcome_id, right_outcome_id
       FROM control_plane_outcome_relations
       WHERE decision = 'serialize' AND (left_outcome_id = ? OR right_outcome_id = ?)`
    )
    .all(outcome.outcome_id, outcome.outcome_id) as {
    left_outcome_id: string
    right_outcome_id: string
  }[]
  for (const relation of relations) {
    const otherId =
      relation.left_outcome_id === outcome.outcome_id
        ? relation.right_outcome_id
        : relation.left_outcome_id
    const active = db.db
      .prepare(
        `SELECT dispatch.id FROM control_plane_outcomes other
         JOIN dispatch_contexts dispatch ON dispatch.run_id = other.run_id
         WHERE other.outcome_id = ? AND dispatch.status IN ('pending', 'dispatched')
         ORDER BY dispatch.rowid ASC LIMIT 1`
      )
      .get(otherId) as { id: string } | undefined
    if (active) {
      throw new OrchestrationError(
        'serialized_with_active_outcome',
        `Outcome ${outcome.outcome_id} is serialized against ${otherId}, which has active Dispatch ${active.id}.`
      )
    }
  }
}

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
    assertAtomicOutcomeStartAllowed(this, task, params.startOptions)
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
    const persistedStartOptions =
      params.startOptions && typeof params.startOptions === 'object'
        ? {
            ...(params.startOptions as Record<string, unknown>),
            ...(params.retryOf ? { retryOf: params.retryOf } : {})
          }
        : params.retryOf
          ? { value: params.startOptions, retryOf: params.retryOf }
          : params.startOptions
    this.db
      .prepare(
        `INSERT INTO worker_dispatches (
           dispatch_id, runtime_epoch, state, stage, start_options
         ) VALUES (?, ?, 'starting', 'accepted', ?)`
      )
      .run(id, params.runtimeEpoch ?? null, JSON.stringify(persistedStartOptions))
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
