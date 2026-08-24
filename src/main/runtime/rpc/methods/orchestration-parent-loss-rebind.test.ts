import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'

describe('orchestration parent checkpoint and approved rebind RPC', () => {
  const harness = createOrchestrationRpcHarness()
  afterEach(() => harness.cleanup())

  it('requires an exact frozen observation and returns a complete rebind receipt', async () => {
    const { db, runtime, ctx, activeRunId } = harness.setup()
    const task = db.createTask({ spec: 'preserve state' })
    const oldDispatch = db.createDispatchContext(
      task.id,
      'term_worker',
      'tab-worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    )
    vi.spyOn(runtime, 'getAgentStatusOrchestrationContextForTerminal').mockReturnValue({
      taskId: task.id,
      dispatchId: oldDispatch.id,
      parentIdentity: 'term_coord',
      parentRuntimeEpoch: 1,
      parentStatus: 'FROZEN',
      inputPolicy: 'FROZEN',
      rebindStatus: 'APPROVAL_REQUIRED'
    })
    vi.mocked(runtime.getLiveTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_new_coord'
        ? 'tab-new:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        : harness.coordinatorPaneKey
    )

    const created = (await harness.call(
      'orchestration.parentCheckpoint',
      {
        dispatch: oldDispatch.id,
        oldParent: 'term_coord',
        checkpoint: JSON.stringify({ head: 'abc123' }),
        from: 'term_worker'
      },
      ctx
    )) as { checkpoint: { id: string; checkpoint_hash: string } }

    const rebound = (await harness.call(
      'orchestration.parentRebind',
      {
        checkpoint: created.checkpoint.id,
        newParent: 'term_new_coord',
        newParentPaneKey: 'tab-new:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        approvedBy: 'human:maintainer',
        approvalId: 'approval-rpc-1',
        leaseMs: 60_000
      },
      ctx
    )) as Record<string, unknown>

    expect(rebound).toMatchObject({
      oldParent: 'term_coord',
      newParent: 'term_new_coord',
      checkpointHash: created.checkpoint.checkpoint_hash,
      approvedBy: 'human:maintainer',
      approvalId: 'approval-rpc-1',
      coordinatorEpoch: 2,
      oldDispatchId: oldDispatch.id
    })
    expect(rebound.newDispatchId).not.toBe(oldDispatch.id)
    expect(rebound.leaseExpiresAt).toBeTruthy()
    expect(rebound.rebindReceiptId).toMatch(/^rebind_/)
    expect(rebound.correlationId).toMatch(/^corr_/)
    expect(db.getRun(activeRunId!)).toMatchObject({ coordinator_handle: 'term_new_coord' })
  })

  it('rejects checkpoint creation when runtime loss evidence does not match', async () => {
    const { db, runtime, ctx } = harness.setup()
    const task = db.createTask({ spec: 'stay active' })
    const dispatch = db.createDispatchContext(task.id, 'term_worker')
    vi.spyOn(runtime, 'getAgentStatusOrchestrationContextForTerminal').mockReturnValue({
      taskId: task.id,
      dispatchId: dispatch.id,
      parentIdentity: 'term_coord',
      parentStatus: 'READY',
      inputPolicy: 'PARENT_ONLY',
      rebindStatus: 'NOT_REQUIRED'
    })

    await expect(
      harness.call(
        'orchestration.parentCheckpoint',
        {
          dispatch: dispatch.id,
          oldParent: 'term_coord',
          checkpoint: 'state',
          from: 'term_worker'
        },
        ctx
      )
    ).rejects.toMatchObject({
      code: 'parent_loss_not_observed',
      data: { effectsApplied: false }
    })
    expect(db.getParentLossCheckpointByDispatch(dispatch.id)).toBeUndefined()
  })

  it('rejects a non-live or cross-plane parent before claiming approval', async () => {
    const { db, runtime, ctx } = harness.setup()
    const task = db.createTask({ spec: 'local only' })
    const dispatch = db.createDispatchContext(task.id, 'term_worker')
    const checkpoint = db.createParentLossCheckpoint({
      dispatchId: dispatch.id,
      oldParent: 'term_coord',
      checkpoint: 'state'
    })
    vi.mocked(runtime.getLiveTerminalPaneKey).mockReturnValue(null)

    await expect(
      harness.call(
        'orchestration.parentRebind',
        {
          checkpoint: checkpoint.id,
          newParent: 'remote:parent',
          newParentPaneKey: 'remote-tab:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          approvedBy: 'human:maintainer',
          approvalId: 'approval-remote',
          leaseMs: 60_000
        },
        ctx
      )
    ).rejects.toMatchObject({
      code: 'rebind_parent_not_live',
      data: { effectsApplied: false }
    })
    expect(db.getParentLossCheckpoint(checkpoint.id)).toMatchObject({
      status: 'checkpointed',
      approval_id: null
    })
  })
})
