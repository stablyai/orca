import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

describe('conditional inject operations', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function prepare(d: OrchestrationDb, taskId: string) {
    return d.prepareConditionalInjectOperation({
      operationId: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:v1',
      requestDigest: 'a'.repeat(64),
      attemptId: '11111111-1111-4111-8111-111111111111',
      dagNodeId: '22222222-2222-4222-8222-222222222222',
      taskId,
      payloadBody: 'work',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: 'tab:coordinator',
      workerHandle: 'term_worker',
      workerPaneKey: 'tab:worker',
      worktreeId: 'repo::/worktree',
      runtimeId: 'runtime-1'
    })
  }

  it('keeps a permanent digest tombstone and rejects conflicting reuse', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'work' })
    const first = prepare(d, task.id)

    expect(first.created).toBe(true)
    expect(prepare(d, task.id)).toMatchObject({ created: false })
    expect(() =>
      d.prepareConditionalInjectOperation({
        operationId: first.operation.operation_id,
        requestDigest: 'b'.repeat(64),
        attemptId: first.operation.attempt_id,
        dagNodeId: first.operation.dag_node_id,
        taskId: task.id,
        payloadBody: 'different',
        coordinatorHandle: 'term_coordinator',
        coordinatorPaneKey: 'tab:coordinator',
        workerHandle: 'term_worker',
        workerPaneKey: 'tab:worker',
        worktreeId: 'repo::/worktree',
        runtimeId: 'runtime-1'
      })
    ).toThrow('different request digest')
    expect(() =>
      d.prepareConditionalInjectOperation({
        operationId: '33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444:v1',
        requestDigest: 'c'.repeat(64),
        attemptId: '33333333-3333-4333-8333-333333333333',
        dagNodeId: '44444444-4444-4444-8444-444444444444',
        taskId: task.id,
        payloadBody: 'replacement',
        coordinatorHandle: 'term_coordinator',
        coordinatorPaneKey: 'tab:coordinator',
        workerHandle: 'term_worker',
        workerPaneKey: 'tab:worker',
        worktreeId: 'repo::/worktree',
        runtimeId: 'runtime-1'
      })
    ).toThrow('already fenced')
  })

  it('allows one delivery-started CAS winner and never reopens it', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'work' })
    const { operation } = prepare(d, task.id)
    const params = {
      operationId: operation.operation_id,
      taskId: task.id,
      workerHandle: 'term_worker',
      workerPaneKey: 'tab:worker',
      processIncarnation: 'process-1'
    }

    const winner = d.startConditionalInjectDelivery(params)
    const loser = d.startConditionalInjectDelivery(params)

    expect(winner.winner).toBe(true)
    expect(winner.operation.status).toBe('delivery-started')
    expect(loser).toMatchObject({ winner: false })
    expect(loser.operation.dispatch_id).toBe(winner.dispatch?.id)
    expect(
      d.settleConditionalInjectOperation(operation.operation_id, 'acknowledged', {
        bytesWritten: 42
      })
    ).toMatchObject({ status: 'acknowledged', bytes_written: 42 })
    expect(d.startConditionalInjectDelivery(params)).toMatchObject({ winner: false })
  })

  it('does not create a dispatch when an operation is rejected', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'work' })
    const { operation } = prepare(d, task.id)

    expect(
      d.rejectConditionalInjectOperation(operation.operation_id, 'identity_mismatch')
    ).toMatchObject({
      status: 'rejected',
      dispatch_id: null,
      failure_reason: 'identity_mismatch'
    })
    expect(d.getDispatchContext(task.id)).toBeUndefined()
  })
})
