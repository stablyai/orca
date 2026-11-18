import type { DispatchContextRow, TaskRow, WorkerDispatchRow } from '../orchestration-records'
import { OrchestrationError } from '../../orchestration-error'
import { ensureMutationReceiptCapacity } from '../mutation-receipts/mutation-receipt-capacity'
import { ORCHESTRATION_CONTRACT_VERSION as CURRENT_CONTRACT_VERSION } from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'
import { insertStartingDispatchContextRow } from '../dispatch-row-writer'
import { recordedCreatorIdentity, type DispatchCreator } from '../dispatch-depth'
import { transitionLifecycleWithDb } from '../lifecycle-transition'
import { taskNotFoundError } from '../../coordinator/dispatch/task-dispatch-refusal'
import { claimTaskForStart } from '../tasks/task-start-claim'
import { getFollowUpDispatch, takeFollowUpMail } from '../dispatch-context/worker-follow-up-lineage'

export function createStartingWorkerDispatch(
  this: OrchestrationDb,
  params: {
    taskId?: string
    taskSpec?: string
    /** The paired coordinator's ID for this Task: an existing one is reopened, else the new one takes it. */
    adoptTaskId?: string
    taskRunId?: string
    taskCreatedByTerminalHandle?: string
    taskCreatedByPaneKey?: string
    taskCreatedByProcessIncarnation?: string
    taskCreatedByRunGeneration?: number
    taskTitle?: string
    taskDeps?: string[]
    taskParentId?: string
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
    /** A worker's own Dispatch that authorized this helper; it must still be the creator here. */
    requiredCreatorDispatchId?: string
    /** The settled Dispatch whose worker this follow-up continues; only one follow-up claims it. */
    followUpOf?: string
    /** Another mutation's pending receipt (a send's follow-up), told what this start accepted. */
    acceptedBy?: { callerFingerprint: string; requestId: string }
    /** The Dispatch whose unread mail this follow-up's Task tells it to check, moved to it in the claim. */
    takesMailOf?: string
  }
): { dispatch: DispatchContextRow; worker: WorkerDispatchRow; task: TaskRow } {
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
    const claimedFollowUp = params.followUpOf ? getFollowUpDispatch(this, params.followUpOf) : null
    if (claimedFollowUp) {
      throw new OrchestrationError(
        'follow_up_claimed',
        `Dispatch ${params.followUpOf} already continues as Dispatch ${claimedFollowUp.id}.`,
        { followUpDispatchId: claimedFollowUp.id }
      )
    }
    const adopted = params.adoptTaskId ? this.getTask(params.adoptTaskId) : undefined
    if (adopted && !params.retryOf) {
      reopenSettledAdoptedTask(this, adopted, params.taskRunId)
    }
    const task = params.taskId
      ? this.getTask(params.taskId)
      : adopted
        ? this.getTask(adopted.id)
        : params.taskSpec
          ? this.createTask({
              id: params.adoptTaskId,
              spec: params.taskSpec,
              taskTitle: params.taskTitle,
              deps: params.taskDeps,
              parentId: params.taskParentId,
              createdByTerminalHandle: params.taskCreatedByTerminalHandle,
              createdByPaneKey: params.taskCreatedByPaneKey,
              createdByProcessIncarnation: params.taskCreatedByProcessIncarnation,
              createdByRunGeneration: params.taskCreatedByRunGeneration,
              runId: params.taskRunId
            })
          : undefined
    if (!task) {
      // An inline spec already creates its Task; missing rows here imply an explicit id.
      const taskId = params.taskId ?? ''
      throw taskNotFoundError(`Task ${taskId} was not found.`, { taskId })
    }
    const peerRun = this.getPeerRun(task.run_id)
    if (peerRun?.state === 'closed') {
      // Starts, follow-ups and helpers alike: its coordinator cancelled it.
      throw new OrchestrationError(
        'run_not_found',
        `Run ${task.run_id} was cancelled by ${peerRun.home_label}. No effects were applied.`,
        { effectsApplied: false }
      )
    }
    const { priorFailures } = claimTaskForStart(this, task, { retryOf: params.retryOf })

    const id = generateId('ctx')
    const creatorDispatchId = this.resolveCreatorDispatchId(params.creator)
    if (
      params.requiredCreatorDispatchId !== undefined &&
      creatorDispatchId !== params.requiredCreatorDispatchId
    ) {
      throw new OrchestrationError(
        'consumer_fenced',
        `Dispatch ${params.requiredCreatorDispatchId} is no longer this caller's active work, so it cannot start a helper.`,
        { effectsApplied: false }
      )
    }
    if (creatorDispatchId && this.isWorkerStopRequested(creatorDispatchId)) {
      throw new OrchestrationError(
        'consumer_fenced',
        `Dispatch ${creatorDispatchId} is being stopped, so it cannot start a helper.`,
        { effectsApplied: false }
      )
    }
    const accepting = params.mutationReceipt ?? params.acceptedBy
    if (accepting) {
      this.db
        .prepare(
          `UPDATE mutation_receipts
           SET receipt = ?, updated_at = datetime('now')
           WHERE caller_fingerprint = ? AND request_id = ? AND state = 'pending'`
        )
        .run(
          JSON.stringify({ accepted: { taskId: task.id, dispatchId: id } }),
          accepting.callerFingerprint,
          accepting.requestId
        )
    }
    insertStartingDispatchContextRow(this.db, {
      id,
      runId: task.run_id,
      taskId: task.id,
      contractVersion: CURRENT_CONTRACT_VERSION,
      launchTokenHash: params.launchTokenHash ?? null,
      depth: this.resolveChildDispatchDepth(params.creator, params.maxDepth),
      retryOfDispatchId: params.retryOf ?? null,
      priorFailures,
      creatorDispatchId,
      followUpOfDispatchId: params.followUpOf ?? null,
      ...recordedCreatorIdentity(params.creator)
    })
    if (params.takesMailOf) {
      takeFollowUpMail(this, params.takesMailOf, id)
    }
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
    transitionLifecycleWithDb(this.db, {
      entity: 'task',
      id: task.id,
      from: params.retryOf ? ['failed', 'blocked'] : 'ready',
      to: 'dispatched',
      projection: { result: null, completed_at: null }
    })
    this.db.exec('COMMIT')
    this.hasAnyDispatchContextsCache = true
    return {
      dispatch: this.getDispatchContextById(id) as DispatchContextRow,
      worker: this.getWorkerDispatch(id) as WorkerDispatchRow,
      task: this.getTask(task.id) as TaskRow
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

/** A Task its paired coordinator reopened gets a new attempt here once its latest attempt settled. */
function reopenSettledAdoptedTask(
  db: OrchestrationDb,
  task: TaskRow,
  runId: string | undefined
): void {
  if (task.run_id !== runId) {
    throw taskNotFoundError(`Task ${task.id} was not found in Run ${runId ?? ''}.`, {
      taskId: task.id
    })
  }
  const latest = db.getDispatchContext(task.id)
  const worker = latest ? db.getWorkerDispatch(latest.id) : undefined
  const settled = worker
    ? ['succeeded', 'failed', 'stopped', 'abandoned'].includes(worker.state)
    : !latest || ['completed', 'failed', 'circuit_broken'].includes(latest.status)
  // A pending Task still waits on its dependencies; the ordinary promotion readies it.
  if (settled && task.status !== 'ready' && task.status !== 'pending') {
    transitionLifecycleWithDb(db.db, {
      entity: 'task',
      id: task.id,
      from: task.status,
      to: 'ready'
    })
  }
}
