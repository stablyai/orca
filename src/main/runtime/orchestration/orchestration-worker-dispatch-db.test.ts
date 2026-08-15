import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_CONTRACT_VERSION, OrchestrationDb } from './db'

describe('OrchestrationDb worker Dispatch state', () => {
  let db: OrchestrationDb | undefined
  let budgetIndex = 0

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    budgetIndex = 0
    return db
  }

  function createBoundedDispatch(
    d: OrchestrationDb,
    params: Omit<
      Parameters<OrchestrationDb['createStartingWorkerDispatch']>[0],
      'budget' | 'deadlineAt'
    >
  ) {
    budgetIndex += 1
    return d.createStartingWorkerDispatch({
      ...params,
      budget: {
        group: 'test-workers',
        index: budgetIndex,
        maxDispatches: 64,
        maxRuntimeMs: 30_000,
        maxRequests: 10,
        requestCapEnforcement: 'prompt_only',
        maxReviewCycles: 0,
        leaf: true
      },
      deadlineAt: '2099-01-01T00:00:00.000Z'
    })
  }

  it('creates and activates a composed worker Dispatch transactionally', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'worker' })
    const started = createBoundedDispatch(d, {
      taskId: task.id,
      startOptions: { topology: 'current', agent: 'codex' }
    })
    expect(started).toMatchObject({
      dispatch: { status: 'pending' },
      worker: { state: 'starting', stage: 'accepted' }
    })
    expect(d.getTask(task.id)?.status).toBe('dispatched')

    const capability = d.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime:pty:1',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: 'term_worker' }]
    })
    expect(capability).toMatch(/^dcap_/)
    expect(d.markWorkerDispatchReady(started.dispatch.id)).toMatchObject({
      state: 'ready',
      stage: 'input_accepted'
    })
    expect(d.getDispatchContextById(started.dispatch.id)).toMatchObject({
      status: 'dispatched',
      assignee_handle: 'term_worker'
    })
    expect(d.listLegacyWorkerTerminalRecoveryRows()).toEqual([
      expect.objectContaining({
        dispatch_id: started.dispatch.id,
        contract_version: CURRENT_CONTRACT_VERSION,
        worker_state: 'ready',
        agent_terminal_handle: 'term_worker'
      })
    ])
  })

  it('reserves bounded Dispatch indices atomically and never reopens consumed slots', () => {
    const d = createDb()
    const firstTask = d.createTask({ spec: 'first bounded worker' })
    const first = d.createStartingWorkerDispatch({
      taskId: firstTask.id,
      startOptions: {},
      budget: {
        group: 'bounded-batch',
        index: 1,
        maxDispatches: 2,
        maxRuntimeMs: 60_000,
        maxRequests: 20,
        requestCapEnforcement: 'hard',
        maxReviewCycles: 2,
        reviewCycle: 1,
        leaf: true
      },
      deadlineAt: '2099-01-01T00:00:00.000Z'
    })
    expect(first.worker).toMatchObject({
      deadline_at: '2099-01-01T00:00:00.000Z',
      max_runtime_ms: 60_000,
      max_requests: 20,
      request_cap_enforcement: 'hard',
      max_review_cycles: 2,
      review_cycle: 1,
      leaf: 1,
      watchdog_sentinel_path: null
    })
    expect(d.getDispatchBudgetGroup(firstTask.run_id, 'bounded-batch')).toMatchObject({
      max_dispatches: 2
    })
    expect(d.listDispatchBudgetReservations(firstTask.run_id, 'bounded-batch')).toEqual([
      expect.objectContaining({
        dispatch_index: 1,
        dispatch_id: first.dispatch.id
      })
    ])

    d.failWorkerStart(first.dispatch.id, 'agent_readiness', 'provider failed')
    const duplicateTask = d.createTask({ spec: 'duplicate slot' })
    expect(() =>
      d.createStartingWorkerDispatch({
        taskId: duplicateTask.id,
        startOptions: {},
        budget: {
          group: 'bounded-batch',
          index: 1,
          maxDispatches: 2,
          maxRuntimeMs: 60_000,
          maxRequests: 20,
          requestCapEnforcement: 'hard',
          maxReviewCycles: 0,
          leaf: true
        },
        deadlineAt: '2099-01-01T00:00:00.000Z'
      })
    ).toThrow('already consumed')
    expect(d.getTask(duplicateTask.id)?.status).toBe('ready')

    const changedMaximumTask = d.createTask({ spec: 'changed group maximum' })
    expect(() =>
      d.createStartingWorkerDispatch({
        taskId: changedMaximumTask.id,
        startOptions: {},
        budget: {
          group: 'bounded-batch',
          index: 2,
          maxDispatches: 3,
          maxRuntimeMs: 60_000,
          maxRequests: 20,
          requestCapEnforcement: 'hard',
          maxReviewCycles: 0,
          leaf: true
        },
        deadlineAt: '2099-01-01T00:00:00.000Z'
      })
    ).toThrow('already has maximum 2')
    expect(d.listDispatchBudgetReservations(firstTask.run_id, 'bounded-batch')).toHaveLength(1)

    const overflowTask = d.createTask({ spec: 'overflow' })
    expect(() =>
      d.createStartingWorkerDispatch({
        taskId: overflowTask.id,
        startOptions: {},
        budget: {
          group: 'overflow-batch',
          index: 3,
          maxDispatches: 2,
          maxRuntimeMs: 60_000,
          maxRequests: 20,
          requestCapEnforcement: 'hard',
          maxReviewCycles: 0,
          leaf: true
        },
        deadlineAt: '2099-01-01T00:00:00.000Z'
      })
    ).toThrow('outside budget group')
    expect(d.getDispatchBudgetGroup(overflowTask.run_id, 'overflow-batch')).toBeUndefined()

    const invalidReviewTask = d.createTask({ spec: 'invalid review cycle' })
    expect(() =>
      d.createStartingWorkerDispatch({
        taskId: invalidReviewTask.id,
        startOptions: {},
        budget: {
          group: 'review-batch',
          index: 1,
          maxDispatches: 1,
          maxRuntimeMs: 60_000,
          maxRequests: 20,
          requestCapEnforcement: 'hard',
          maxReviewCycles: 2,
          reviewCycle: 3,
          leaf: true
        },
        deadlineAt: '2099-01-01T00:00:00.000Z'
      })
    ).toThrow('within the configured maximum')
    expect(d.getDispatchBudgetGroup(invalidReviewTask.run_id, 'review-batch')).toBeUndefined()

    const rollbackTask = d.createTask({ spec: 'rollback after reservation' })
    const circular: { self?: unknown } = {}
    circular.self = circular
    expect(() =>
      d.createStartingWorkerDispatch({
        taskId: rollbackTask.id,
        startOptions: circular,
        budget: {
          group: 'rollback-batch',
          index: 1,
          maxDispatches: 1,
          maxRuntimeMs: 60_000,
          maxRequests: 20,
          requestCapEnforcement: 'hard',
          maxReviewCycles: 0,
          leaf: true
        },
        deadlineAt: '2099-01-01T00:00:00.000Z'
      })
    ).toThrow()
    expect(d.getDispatchBudgetGroup(rollbackTask.run_id, 'rollback-batch')).toBeUndefined()
    expect(d.getTask(rollbackTask.id)?.status).toBe('ready')
  })

  it('binds a Run to one durable Dispatch budget group', () => {
    const d = createDb()
    const firstTask = d.createTask({ spec: 'first group' })
    const first = createBoundedDispatch(d, { taskId: firstTask.id, startOptions: {} })
    d.failWorkerStart(first.dispatch.id, 'agent_readiness', 'failed')
    const secondTask = d.createTask({ spec: 'second group' })

    expect(() =>
      d.createStartingWorkerDispatch({
        taskId: secondTask.id,
        startOptions: {},
        budget: {
          group: 'replacement-group',
          index: 1,
          maxDispatches: 64,
          maxRuntimeMs: 30_000,
          maxRequests: 10,
          requestCapEnforcement: 'prompt_only',
          maxReviewCycles: 0,
          leaf: true
        },
        deadlineAt: '2099-01-01T00:00:00.000Z'
      })
    ).toThrow('already bound')
  })

  it('does not let a retry redefine its review-cycle maximum', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'review retry' })
    const first = d.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      budget: {
        group: 'review-retry',
        index: 1,
        maxDispatches: 2,
        maxRuntimeMs: 30_000,
        maxRequests: 10,
        requestCapEnforcement: 'prompt_only',
        maxReviewCycles: 2,
        reviewCycle: 1,
        leaf: true
      },
      deadlineAt: '2099-01-01T00:00:00.000Z'
    })
    d.failWorkerStart(first.dispatch.id, 'agent_readiness', 'failed')

    expect(() =>
      d.createStartingWorkerDispatch({
        taskId: task.id,
        retryOf: first.dispatch.id,
        startOptions: {},
        budget: {
          group: 'review-retry',
          index: 2,
          maxDispatches: 2,
          maxRuntimeMs: 30_000,
          maxRequests: 10,
          requestCapEnforcement: 'prompt_only',
          maxReviewCycles: 0,
          leaf: true
        },
        deadlineAt: '2099-01-01T00:01:00.000Z'
      })
    ).toThrow('preserve')
  })

  it('requeues an active Task before settling a worker whose terminal is missing', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'recover missing worker' })
    const started = createBoundedDispatch(d, {
      taskId: task.id,
      startOptions: { topology: 'current', agent: 'codex' }
    })
    d.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_missing',
      paneKey: 'tab_missing:11111111-1111-4111-8111-111111111111',
      processIncarnation: 'pty-missing:22222222-2222-4222-8222-222222222222',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    d.markWorkerDispatchReady(started.dispatch.id)

    expect(
      d.reconcileMissingWorkerTerminal(started.dispatch.id, 'worker terminal is no longer live')
    ).toMatchObject({
      state: 'abandoned',
      stage: 'terminal_missing',
      last_error: 'worker terminal is no longer live'
    })
    expect(d.getDispatchContextById(started.dispatch.id)).toMatchObject({
      status: 'failed',
      failure_count: 1,
      last_failure: 'worker terminal is no longer live'
    })
    expect(d.getTask(task.id)?.status).toBe('ready')

    d.reconcileMissingWorkerTerminal(started.dispatch.id, 'duplicate recovery')
    expect(d.getDispatchContextById(started.dispatch.id)?.failure_count).toBe(1)
    expect(d.getTask(task.id)?.status).toBe('ready')
  })

  it('commits worker-start mutation acceptance with the starting Dispatch', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'atomic acceptance' })
    const mutationReceipt = {
      callerFingerprint: 'caller_fingerprint',
      requestId: 'worker_start_request',
      method: 'orchestration.workerStart',
      payloadHash: 'payload_hash'
    }

    const started = createBoundedDispatch(d, {
      taskId: task.id,
      startOptions: { topology: 'current' },
      mutationReceipt
    })

    expect(d.getMutationReceipt('caller_fingerprint', 'worker_start_request')).toMatchObject({
      state: 'pending',
      method: 'orchestration.workerStart'
    })
    expect(d.getWorkerDispatch(started.dispatch.id)).toMatchObject({
      state: 'starting',
      stage: 'accepted'
    })
    expect(d.getTask(task.id)?.status).toBe('dispatched')
  })

  it('rolls back worker-start mutation acceptance when the Task cannot start', () => {
    const d = createDb()

    expect(() =>
      createBoundedDispatch(d, {
        taskId: 'task_missing',
        startOptions: {},
        mutationReceipt: {
          callerFingerprint: 'caller_fingerprint',
          requestId: 'invalid_worker_start',
          method: 'orchestration.workerStart',
          payloadHash: 'payload_hash'
        }
      })
    ).toThrow('was not found')
    expect(d.getMutationReceipt('caller_fingerprint', 'invalid_worker_start')).toBeUndefined()
  })

  it('fails a composed start without losing residual resource receipts', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'worker' })
    const started = createBoundedDispatch(d, { taskId: task.id, startOptions: {} })
    d.recordWorkerStage({
      dispatchId: started.dispatch.id,
      stage: 'terminal_created',
      effects: [{ kind: 'terminal', action: 'created', id: 'term_worker' }],
      residualResources: [{ kind: 'terminal', id: 'term_worker' }]
    })

    expect(d.failWorkerStart(started.dispatch.id, 'agent_readiness', 'timed out')).toMatchObject({
      state: 'failed',
      stage: 'agent_readiness',
      last_error: 'timed out',
      residual_resources: expect.stringContaining('term_worker')
    })
    expect(d.getTask(task.id)?.status).toBe('failed')
  })

  it('allows retry only from the Task current terminal Dispatch', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'retry current' })
    const first = createBoundedDispatch(d, { taskId: task.id, startOptions: {} })
    d.failWorkerStart(first.dispatch.id, 'agent_readiness', 'first failed')
    const second = createBoundedDispatch(d, {
      taskId: task.id,
      retryOf: first.dispatch.id,
      startOptions: {}
    })
    d.failWorkerStart(second.dispatch.id, 'agent_readiness', 'second failed')

    expect(() =>
      createBoundedDispatch(d, {
        taskId: task.id,
        retryOf: first.dispatch.id,
        startOptions: {}
      })
    ).toThrow('cannot retry')
    expect(
      createBoundedDispatch(d, {
        taskId: task.id,
        retryOf: second.dispatch.id,
        startOptions: {}
      }).worker.state
    ).toBe('starting')
  })

  it('requires retries to preserve runtime, request, enforcement, and deadline limits', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'immutable retry budget' })
    const firstBudget = {
      group: 'immutable-retry',
      index: 1,
      maxDispatches: 4,
      maxRuntimeMs: 1_000,
      maxRequests: 1,
      requestCapEnforcement: 'prompt_only' as const,
      maxReviewCycles: 0,
      leaf: true as const
    }
    const first = d.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      budget: firstBudget,
      deadlineAt: '2099-01-01T00:00:01.000Z'
    })
    d.failWorkerStart(first.dispatch.id, 'agent_readiness', 'first failed')

    for (const mismatch of [
      { maxRuntimeMs: 7_200_000 },
      { maxRequests: 100 },
      { requestCapEnforcement: 'hard' as const }
    ]) {
      expect(() =>
        d.createStartingWorkerDispatch({
          taskId: task.id,
          retryOf: first.dispatch.id,
          startOptions: {},
          budget: { ...firstBudget, ...mismatch, index: 2 },
          deadlineAt: '2099-01-01T00:00:01.000Z'
        })
      ).toThrow('must preserve')
    }
    expect(() =>
      d.createStartingWorkerDispatch({
        taskId: task.id,
        retryOf: first.dispatch.id,
        startOptions: {},
        budget: { ...firstBudget, index: 2 },
        deadlineAt: '2099-01-01T00:00:02.000Z'
      })
    ).toThrow('must preserve')

    expect(
      d.createStartingWorkerDispatch({
        taskId: task.id,
        retryOf: first.dispatch.id,
        startOptions: {},
        budget: { ...firstBudget, index: 2 },
        deadlineAt: '2099-01-01T00:00:01.000Z'
      }).worker
    ).toMatchObject({
      deadline_at: '2099-01-01T00:00:01.000Z',
      max_runtime_ms: 1_000,
      max_requests: 1,
      request_cap_enforcement: 'prompt_only'
    })
  })

  it('treats abandon of a superseded Dispatch as a no-op', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'stale abandon' })
    const first = createBoundedDispatch(d, { taskId: task.id, startOptions: {} })
    d.failWorkerStart(first.dispatch.id, 'agent_readiness', 'first failed')
    const second = createBoundedDispatch(d, {
      taskId: task.id,
      retryOf: first.dispatch.id,
      startOptions: {}
    })
    d.prepareStartingWorkerAuthority({
      dispatchId: second.dispatch.id,
      handle: 'term_replacement',
      paneKey: 'tab_replacement:leaf_replacement',
      processIncarnation: 'runtime:pty:2',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    d.markWorkerDispatchReady(second.dispatch.id)

    expect(d.abandonWorkerDispatch(first.dispatch.id)).toMatchObject({
      disposition: 'stale',
      worker: { state: 'failed' }
    })
    expect(d.getTask(task.id)?.status).toBe('dispatched')
    expect(d.getWorkerDispatch(second.dispatch.id)?.state).toBe('ready')
    expect(
      d.settleWorkerReport({
        taskId: task.id,
        dispatchId: second.dispatch.id,
        outcome: 'succeeded',
        result: '{}'
      })
    ).toMatchObject({ action: 'settled' })
    expect(d.getTask(task.id)?.status).toBe('completed')
  })

  it('lets the stop fence win before a late worker completion', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'race' })
    const started = createBoundedDispatch(d, { taskId: task.id, startOptions: {} })
    d.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime:pty:1',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    d.markWorkerDispatchReady(started.dispatch.id)

    expect(d.beginWorkerStop(started.dispatch.id).disposition).toBe('stopping')
    expect(
      d.settleWorkerReport({
        taskId: task.id,
        dispatchId: started.dispatch.id,
        outcome: 'succeeded',
        result: '{}'
      })
    ).toMatchObject({ action: 'rejected', code: 'inactive_dispatch' })
    expect(d.settleWorkerStop(started.dispatch.id).state).toBe('stopped')
    expect(d.getTask(task.id)?.status).toBe('blocked')
  })

  it('allows explicit stop recovery from uncertain local and remote starts', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'uncertain local start' })
    const started = createBoundedDispatch(d, { taskId: task.id, startOptions: {} })
    d.markWorkerStartUnknown(started.dispatch.id, 'agent_readiness', 'connection lost')

    expect(d.beginWorkerStop(started.dispatch.id)).toMatchObject({
      disposition: 'stopping',
      worker: { state: 'stopping' }
    })

    d.createRemoteDispatchAttachment({
      dispatchId: 'ctx_remote_unknown',
      taskId: 'task_remote_unknown',
      homePeerFingerprint: 'home_peer',
      protocolVersion: 1,
      runtimeEpoch: 'worker_epoch',
      deadlineAt: '2099-01-01T00:00:00.000Z',
      maxRequests: 10,
      mutationReceipt: {
        callerFingerprint: 'home_peer',
        requestId: 'remote_unknown_start',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'remote_unknown_payload'
      }
    })
    d.recordRemoteAttachmentStage({
      dispatchId: 'ctx_remote_unknown',
      stage: 'agent_readiness',
      state: 'start_unknown',
      terminalHandle: 'term_remote_worker'
    })

    expect(d.beginRemoteAttachmentStop('ctx_remote_unknown')).toMatchObject({
      state: 'stopping',
      stage: 'stop_requested',
      capability_hash: null
    })
  })

  it('returns already-settled when completion wins before stop', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'race' })
    const started = createBoundedDispatch(d, { taskId: task.id, startOptions: {} })
    d.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime:pty:1',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    d.markWorkerDispatchReady(started.dispatch.id)
    expect(
      d.settleWorkerReport({
        taskId: task.id,
        dispatchId: started.dispatch.id,
        outcome: 'succeeded',
        result: '{}'
      })
    ).toMatchObject({ action: 'settled' })

    expect(d.beginWorkerStop(started.dispatch.id)).toMatchObject({
      disposition: 'already_settled',
      worker: { state: 'succeeded' }
    })
  })
})
