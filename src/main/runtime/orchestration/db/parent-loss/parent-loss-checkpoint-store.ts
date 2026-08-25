import { createHash } from 'node:crypto'
import type { ParentLossCheckpointRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'

const MAX_REBIND_LEASE_MS = 5 * 60_000

export function createParentLossCheckpoint(
  this: OrchestrationDb,
  params: { dispatchId: string; oldParent: string; checkpoint: string }
): ParentLossCheckpointRow {
  const dispatch = this.getDispatchContextById(params.dispatchId)
  if (!dispatch || (dispatch.status !== 'pending' && dispatch.status !== 'dispatched')) {
    throw new OrchestrationError('dispatch_not_active', 'Only an active Dispatch can checkpoint.', {
      effectsApplied: false,
      dispatchId: params.dispatchId
    })
  }
  const id = generateId('checkpoint')
  const checkpointHash = createHash('sha256').update(params.checkpoint).digest('hex')
  try {
    const updatedRun = this.db
      .prepare(
        `UPDATE runs
         SET coordinator_handle = ?, coordinator_pane_key = ?,
             consumer_generation = consumer_generation + 1, updated_at = datetime('now')
         WHERE id = ? AND legacy = 0`
      )
      .run(params.newParent, params.newParentPaneKey, checkpoint.run_id)
    if (updatedRun.changes !== 1) {
      throw new OrchestrationError(
        'rebind_not_available',
        'A non-legacy run is required for parent rebind.',
        { effectsApplied: false, checkpointId: checkpoint.id }
      )
    }
    this.db
      .prepare(
        `INSERT INTO parent_loss_checkpoints
           (id, run_id, task_id, old_dispatch_id, old_parent, checkpoint_hash)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, dispatch.run_id, dispatch.task_id, dispatch.id, params.oldParent, checkpointHash)
  } catch (error) {
    const existing = this.getParentLossCheckpointByDispatch(dispatch.id)
    if (existing) {
      throw new OrchestrationError(
        'checkpoint_exists',
        `Dispatch ${dispatch.id} already has checkpoint ${existing.id}.`,
        { effectsApplied: false, checkpointId: existing.id }
      )
    }
    throw error
  }
  return this.getParentLossCheckpoint(id) as ParentLossCheckpointRow
}

export function getParentLossCheckpoint(
  this: OrchestrationDb,
  id: string
): ParentLossCheckpointRow | undefined {
  return this.db.prepare('SELECT * FROM parent_loss_checkpoints WHERE id = ?').get(id) as
    | ParentLossCheckpointRow
    | undefined
}

export function getParentLossCheckpointByDispatch(
  this: OrchestrationDb,
  dispatchId: string
): ParentLossCheckpointRow | undefined {
  return this.db
    .prepare('SELECT * FROM parent_loss_checkpoints WHERE old_dispatch_id = ?')
    .get(dispatchId) as ParentLossCheckpointRow | undefined
}

export function approveParentLossRebind(
  this: OrchestrationDb,
  params: {
    checkpointId: string
    newParent: string
    newParentPaneKey: string
    approvedBy: string
    approvalId: string
    leaseMs: number
  }
): { checkpoint: ParentLossCheckpointRow; newDispatchId: string } {
  const checkpoint = this.getParentLossCheckpoint(params.checkpointId)
  if (!checkpoint || checkpoint.status !== 'checkpointed') {
    throw new OrchestrationError(
      'rebind_not_available',
      'Checkpoint is missing or already rebound.',
      {
        effectsApplied: false,
        checkpointId: params.checkpointId
      }
    )
  }
  if (!params.approvedBy.trim().startsWith('human:') || !params.approvalId.trim()) {
    throw new OrchestrationError('approval_required', 'Human approval evidence is required.', {
      effectsApplied: false
    })
  }
  if (!Number.isFinite(params.leaseMs) || params.leaseMs <= 0) {
    throw new OrchestrationError(
      'rebind_lease_expired',
      'A live positive rebind lease is required.',
      {
        effectsApplied: false,
        checkpointId: checkpoint.id
      }
    )
  }
  const leaseMs = Math.max(1_000, Math.min(params.leaseMs, MAX_REBIND_LEASE_MS))
  const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString()
  const receiptId = generateId('rebind')
  const correlationId = generateId('corr')

  this.db.exec('BEGIN IMMEDIATE')
  try {
    const claimed = this.db
      .prepare(
        `UPDATE parent_loss_checkpoints
         SET approved_by = ?, approval_id = ?, new_parent = ?, lease_expires_at = ?
         WHERE id = ? AND status = 'checkpointed' AND approval_id IS NULL`
      )
      .run(
        params.approvedBy.trim(),
        params.approvalId.trim(),
        params.newParent,
        leaseExpiresAt,
        checkpoint.id
      )
    if (claimed.changes !== 1) {
      throw new OrchestrationError('rebind_lease_conflict', 'Checkpoint lease is already owned.', {
        effectsApplied: false,
        checkpointId: checkpoint.id
      })
    }
    const oldDispatch = this.getDispatchContextById(checkpoint.old_dispatch_id)
    if (
      !oldDispatch ||
      (oldDispatch.status !== 'pending' && oldDispatch.status !== 'dispatched') ||
      Date.parse(leaseExpiresAt) <= Date.now()
    ) {
      throw new OrchestrationError(
        'rebind_lease_expired',
        'The old Dispatch is inactive or the rebind lease expired.',
        { effectsApplied: false, checkpointId: checkpoint.id }
      )
    }
    if (!oldDispatch.assignee_handle) {
      throw new OrchestrationError(
        'rebind_target_missing',
        'The old Dispatch has no worker handle.',
        {
          effectsApplied: false,
          checkpointId: checkpoint.id
        }
      )
    }
    this.db
      .prepare(
        `UPDATE dispatch_contexts
         SET status = 'failed', completed_at = datetime('now'), last_failure = 'parent_lost_rebound'
         WHERE id = ? AND status IN ('pending', 'dispatched')`
      )
      .run(oldDispatch.id)
    this.db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(checkpoint.task_id)
    const newDispatch = this.createDispatchContext(
      checkpoint.task_id,
      oldDispatch.assignee_handle,
      oldDispatch.assignee_pane_key ?? undefined,
      undefined,
      oldDispatch.process_incarnation ?? undefined
    )
    const epoch = this.getRun(checkpoint.run_id)?.consumer_generation
    this.db
      .prepare(
        `UPDATE parent_loss_checkpoints
         SET status = 'rebound', new_dispatch_id = ?, coordinator_epoch = ?,
             rebind_receipt_id = ?, correlation_id = ?, rebound_at = datetime('now')
         WHERE id = ? AND status = 'checkpointed'`
      )
      .run(newDispatch.id, epoch ?? null, receiptId, correlationId, checkpoint.id)
    this.db.exec('COMMIT')
    return {
      checkpoint: this.getParentLossCheckpoint(checkpoint.id) as ParentLossCheckpointRow,
      newDispatchId: newDispatch.id
    }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type ParentLossCheckpointStoreMethods = {
  createParentLossCheckpoint: typeof createParentLossCheckpoint
  getParentLossCheckpoint: typeof getParentLossCheckpoint
  getParentLossCheckpointByDispatch: typeof getParentLossCheckpointByDispatch
  approveParentLossRebind: typeof approveParentLossRebind
}

export function attachParentLossCheckpointStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createParentLossCheckpoint,
    getParentLossCheckpoint,
    getParentLossCheckpointByDispatch,
    approveParentLossRebind
  })
}
