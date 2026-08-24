import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

describe('parent-loss checkpoint storage', () => {
  it('persists a content hash and rebinds through a new dispatch and coordinator epoch', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'recover worker',
        coordinatorHandle: 'term_old_parent',
        coordinatorPaneKey: 'tab-old:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      })
      const task = db.createTask({ spec: 'preserve work', runId: run.id })
      const oldDispatch = db.createDispatchContext(
        task.id,
        'term_worker',
        'tab-worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      )

      const checkpoint = db.createParentLossCheckpoint({
        dispatchId: oldDispatch.id,
        oldParent: 'term_old_parent',
        checkpoint: JSON.stringify({ head: 'abc123', dirty: true })
      })
      expect(checkpoint).toMatchObject({
        old_dispatch_id: oldDispatch.id,
        old_parent: 'term_old_parent',
        status: 'checkpointed'
      })
      expect(checkpoint.checkpoint_hash).toMatch(/^[a-f0-9]{64}$/)

      const rebound = db.approveParentLossRebind({
        checkpointId: checkpoint.id,
        newParent: 'term_new_parent',
        newParentPaneKey: 'tab-new:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        approvedBy: 'human:maintainer',
        approvalId: 'approval-1',
        leaseMs: 60_000
      })

      expect(rebound.newDispatchId).not.toBe(oldDispatch.id)
      expect(db.getDispatchContextById(oldDispatch.id)?.status).toBe('failed')
      expect(db.getDispatchContextById(rebound.newDispatchId)).toMatchObject({
        task_id: task.id,
        assignee_handle: 'term_worker',
        status: 'dispatched'
      })
      expect(db.getRun(run.id)).toMatchObject({
        coordinator_handle: 'term_new_parent',
        consumer_generation: run.consumer_generation + 1
      })
      expect(rebound.checkpoint).toMatchObject({
        status: 'rebound',
        new_parent: 'term_new_parent',
        approved_by: 'human:maintainer',
        approval_id: 'approval-1',
        coordinator_epoch: run.consumer_generation + 1
      })
      expect(rebound.checkpoint.lease_expires_at).toBeTruthy()
      expect(rebound.checkpoint.rebind_receipt_id).toMatch(/^rebind_/)
      expect(rebound.checkpoint.correlation_id).toMatch(/^corr_/)
    } finally {
      db.close()
    }
  })

  it('rejects duplicate checkpoint and duplicate rebind without changing the new dispatch', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'single writer',
        coordinatorHandle: 'old',
        coordinatorPaneKey: 'tab-old:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      })
      const task = db.createTask({ spec: 'work', runId: run.id })
      const dispatch = db.createDispatchContext(task.id, 'worker')
      const checkpoint = db.createParentLossCheckpoint({
        dispatchId: dispatch.id,
        oldParent: 'old',
        checkpoint: 'state'
      })
      expect(() =>
        db.approveParentLossRebind({
          checkpointId: checkpoint.id,
          newParent: 'new',
          newParentPaneKey: 'tab-new:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          approvedBy: 'human:test',
          approvalId: 'approval-expired',
          leaseMs: 0
        })
      ).toThrowError(expect.objectContaining({ code: 'rebind_lease_expired' }))
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
      expect(() =>
        db.createParentLossCheckpoint({
          dispatchId: dispatch.id,
          oldParent: 'old',
          checkpoint: 'state'
        })
      ).toThrowError(expect.objectContaining({ code: 'checkpoint_exists' }))
      const first = db.approveParentLossRebind({
        checkpointId: checkpoint.id,
        newParent: 'new',
        newParentPaneKey: 'tab-new:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        approvedBy: 'human:test',
        approvalId: 'approval-unique',
        leaseMs: 60_000
      })
      expect(() =>
        db.approveParentLossRebind({
          checkpointId: checkpoint.id,
          newParent: 'other',
          newParentPaneKey: 'tab-other:dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          approvedBy: 'human:test',
          approvalId: 'approval-other',
          leaseMs: 60_000
        })
      ).toThrowError(expect.objectContaining({ code: 'rebind_not_available' }))
      expect(db.getParentLossCheckpoint(checkpoint.id)?.new_dispatch_id).toBe(first.newDispatchId)
    } finally {
      db.close()
    }
  })
})
