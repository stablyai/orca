import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_CONTRACT_VERSION, OrchestrationDb } from './db'

function makeTaskReady(db: OrchestrationDb, taskId: string): void {
  db.updateTaskStatus(taskId, 'ready')
}

describe('OrchestrationDb worker Dispatch state', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function createFederatedStart(d: OrchestrationDb, taskId: string, environmentId: string) {
    return d.createStartingWorkerDispatch({
      taskId,
      startOptions: {},
      federation: {
        environmentId,
        environmentName: environmentId,
        peerFingerprint: `peer-${environmentId}`,
        protocolVersion: 1
      }
    })
  }

  it('creates and activates a composed worker Dispatch transactionally', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'worker' })
    const started = d.createStartingWorkerDispatch({
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

  it('current missing worker is requeued before terminal settlement', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'recover missing worker' })
    const started = d.createStartingWorkerDispatch({
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

  it('settles a superseded missing worker without requeueing its task', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'superseded missing worker' })
    const first = d.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })
    d.prepareStartingWorkerAuthority({
      dispatchId: first.dispatch.id,
      handle: 'term_missing_a',
      paneKey: 'tab_missing_a:11111111-1111-4111-8111-111111111111',
      processIncarnation: 'pty-missing-a:22222222-2222-4222-8222-222222222222',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    d.markWorkerDispatchReady(first.dispatch.id)
    d.updateTaskStatus(task.id, 'ready')

    const replacement = d.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })
    d.prepareStartingWorkerAuthority({
      dispatchId: replacement.dispatch.id,
      handle: 'term_missing_b',
      paneKey: 'tab_missing_b:33333333-3333-4333-8333-333333333333',
      processIncarnation: 'pty-missing-b:44444444-4444-4444-8444-444444444444',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    d.markWorkerDispatchReady(replacement.dispatch.id)

    expect(
      d.reconcileMissingWorkerTerminal(first.dispatch.id, 'superseded terminal is gone')
    ).toMatchObject({ state: 'abandoned', stage: 'terminal_missing' })
    expect(d.getDispatchContextById(first.dispatch.id)).toMatchObject({
      status: 'failed',
      failure_count: 0,
      last_failure: 'superseded terminal is gone'
    })
    expect(d.getTask(task.id)?.status).toBe('dispatched')
    expect(d.getDispatchContextById(replacement.dispatch.id)?.status).toBe('dispatched')
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

    const started = d.createStartingWorkerDispatch({
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
      d.createStartingWorkerDispatch({
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
    const started = d.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })
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

  it('blocks the task for a current worker-start uncertainty', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'current worker-start uncertainty' })
    const started = d.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })

    expect(
      d.markWorkerStartUnknown(started.dispatch.id, 'agent_readiness', 'launch uncertain')
    ).toMatchObject({
      state: 'start_unknown'
    })
    expect(d.getTask(task.id)?.status).toBe('blocked')
  })

  it('requeues a current start_unknown worker when its terminal is missing', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'current start_unknown terminal missing' })
    const started = d.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })
    d.markWorkerStartUnknown(started.dispatch.id, 'agent_readiness', 'launch uncertain')

    expect(d.getTask(task.id)?.status).toBe('blocked')
    expect(
      d.reconcileMissingWorkerTerminal(started.dispatch.id, 'terminal is not present')
    ).toMatchObject({ state: 'abandoned', stage: 'terminal_missing' })
    expect(d.getTask(task.id)).toMatchObject({ status: 'ready' })
    expect(d.getWorkerDispatch(started.dispatch.id)).toMatchObject({
      state: 'abandoned',
      stage: 'terminal_missing',
      last_error: 'terminal is not present'
    })
    expect(d.getDispatchContextById(started.dispatch.id)).toMatchObject({
      status: 'failed',
      failure_count: 1,
      last_failure: 'terminal is not present',
      capability_revoked_at: expect.any(String),
      completed_at: expect.any(String)
    })
    expect(d.getWorkerDispatch(started.dispatch.id)?.updated_at).toBeTruthy()
  })

  it('circuit-breaks the third current start_unknown terminal loss', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'third start_unknown terminal missing' })
    let retryOf: string | undefined
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const started = d.createStartingWorkerDispatch({
        taskId: task.id,
        startOptions: {},
        retryOf
      })
      d.reconcileMissingWorkerTerminal(started.dispatch.id, `failure ${attempt}`)
      d.updateTaskStatus(task.id, 'failed')
      retryOf = started.dispatch.id
    }
    const started = d.createStartingWorkerDispatch({ taskId: task.id, startOptions: {}, retryOf })
    d.markWorkerStartUnknown(started.dispatch.id, 'agent_readiness', 'launch uncertain')
    d.reconcileMissingWorkerTerminal(started.dispatch.id, 'third terminal is not present')

    expect(d.getTask(task.id)).toMatchObject({ status: 'failed' })
    expect(d.getDispatchContextById(started.dispatch.id)).toMatchObject({
      status: 'circuit_broken',
      failure_count: 3
    })
  })

  it('keeps a current federated ready start dispatched', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'current federated ready' })
    const started = createFederatedStart(d, task.id, 'env-current')

    expect(
      d.reconcileFederatedWorkerStart({
        dispatchId: started.dispatch.id,
        state: 'ready',
        stage: 'remote_ready'
      })
    ).toMatchObject({ state: 'ready' })
    expect(d.getTask(task.id)?.status).toBe('dispatched')
    expect(d.getDispatchContextById(started.dispatch.id)?.status).toBe('dispatched')
  })

  it('covers the current federated receipt matrix', () => {
    const d = createDb()
    for (const state of ['failed', 'stopped'] as const) {
      const task = d.createTask({ spec: `current federated ${state}` })
      const started = createFederatedStart(d, task.id, `env-${state}`)
      expect(
        d.reconcileFederatedWorkerStart({
          dispatchId: started.dispatch.id,
          state,
          stage: 'remote_terminal',
          lastError: `remote ${state}`
        })
      ).toMatchObject({ state })
      expect(d.getTask(task.id)).toMatchObject({
        status: 'failed',
        completed_at: expect.any(String)
      })
    }

    const blockedTask = d.createTask({ spec: 'current federated ready from blocked' })
    const blocked = createFederatedStart(d, blockedTask.id, 'env-blocked')
    d.markWorkerStartUnknown(blocked.dispatch.id, 'remote_start', 'launch uncertain')
    expect(
      d.reconcileFederatedWorkerStart({
        dispatchId: blocked.dispatch.id,
        state: 'ready',
        stage: 'remote_ready'
      })
    ).toMatchObject({ state: 'ready' })
    expect(d.getTask(blockedTask.id)?.status).toBe('dispatched')

    const unknownTask = d.createTask({ spec: 'current federated unknown from blocked' })
    const unknown = createFederatedStart(d, unknownTask.id, 'env-unknown')
    d.markWorkerStartUnknown(unknown.dispatch.id, 'remote_start', 'launch uncertain')
    expect(
      d.reconcileFederatedWorkerStart({
        dispatchId: unknown.dispatch.id,
        state: 'start_unknown',
        stage: 'remote_unknown',
        lastError: 'still uncertain'
      })
    ).toMatchObject({ state: 'start_unknown' })
    expect(d.getTask(unknownTask.id)?.status).toBe('blocked')
    expect(d.getWorkerDispatch(unknown.dispatch.id)).toMatchObject({
      state: 'start_unknown',
      stage: 'remote_unknown',
      last_error: 'still uncertain'
    })
  })

  it('blocks a current federated start_unknown receipt from starting', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'federated start unknown from starting' })
    const started = createFederatedStart(d, task.id, 'env-starting')

    expect(
      d.reconcileFederatedWorkerStart({
        dispatchId: started.dispatch.id,
        state: 'start_unknown',
        stage: 'remote_start',
        lastError: 'remote launch uncertain'
      })
    ).toMatchObject({ state: 'start_unknown' })
    expect(d.getTask(task.id)?.status).toBe('blocked')
    expect(d.getWorkerDispatch(started.dispatch.id)).toMatchObject({
      state: 'start_unknown',
      stage: 'remote_start',
      last_error: 'remote launch uncertain'
    })
    expect(d.getDispatchContextById(started.dispatch.id)).toMatchObject({
      status: 'pending',
      capability_revoked_at: expect.any(String)
    })

    const taskBeforeRepeat = d.getTask(task.id)
    const dispatchBeforeRepeat = d.getDispatchContextById(started.dispatch.id)
    expect(
      d.reconcileFederatedWorkerStart({
        dispatchId: started.dispatch.id,
        state: 'start_unknown',
        stage: 'remote_retry',
        lastError: 'remote launch still uncertain'
      })
    ).toMatchObject({ state: 'start_unknown' })
    expect(d.getWorkerDispatch(started.dispatch.id)).toMatchObject({
      state: 'start_unknown',
      stage: 'remote_retry',
      last_error: 'remote launch still uncertain'
    })
    expect(d.getTask(task.id)).toEqual(taskBeforeRepeat)
    expect(d.getDispatchContextById(started.dispatch.id)).toMatchObject({
      status: dispatchBeforeRepeat?.status,
      failure_count: dispatchBeforeRepeat?.failure_count,
      completed_at: dispatchBeforeRepeat?.completed_at,
      capability_revoked_at: dispatchBeforeRepeat?.capability_revoked_at
    })
  })

  it('keeps a replacement task dispatched after a stale worker-start failure', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'stale worker-start failure' })
    const first = d.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })
    makeTaskReady(d, task.id)
    const replacement = d.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })

    expect(d.failWorkerStart(first.dispatch.id, 'agent_readiness', 'late failure')).toMatchObject({
      state: 'failed'
    })
    expect(d.getDispatchContextById(first.dispatch.id)).toMatchObject({ status: 'failed' })
    expect(d.getDispatchContextById(replacement.dispatch.id)).toMatchObject({ status: 'pending' })
    expect(d.getTask(task.id)?.status).toBe('dispatched')
  })

  it('keeps a replacement task dispatched after a stale worker-start uncertainty', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'stale worker-start uncertainty' })
    const first = d.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })
    makeTaskReady(d, task.id)
    const replacement = d.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })

    expect(
      d.markWorkerStartUnknown(first.dispatch.id, 'agent_readiness', 'late uncertainty')
    ).toMatchObject({
      state: 'start_unknown'
    })
    expect(d.getDispatchContextById(replacement.dispatch.id)).toMatchObject({ status: 'pending' })
    expect(d.getTask(task.id)?.status).toBe('dispatched')
  })

  it('keeps a replacement task dispatched after stale federated start failure reconciliation', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'stale federated start failure' })
    const first = d.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      federation: {
        environmentId: 'env-a',
        environmentName: 'A',
        peerFingerprint: 'peer-a',
        protocolVersion: 1
      }
    })
    makeTaskReady(d, task.id)
    const replacement = d.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })

    expect(
      d.reconcileFederatedWorkerStart({
        dispatchId: first.dispatch.id,
        state: 'failed',
        stage: 'remote_start',
        lastError: 'late federated failure'
      })
    ).toMatchObject({ state: 'failed' })
    expect(d.getDispatchContextById(first.dispatch.id)).toMatchObject({ status: 'failed' })
    expect(d.getDispatchContextById(replacement.dispatch.id)).toMatchObject({ status: 'pending' })
    expect(d.getTask(task.id)?.status).toBe('dispatched')
  })

  it('keeps a blocked replacement after a stale federated ready reconciliation', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'stale federated ready' })
    const first = createFederatedStart(d, task.id, 'env-a')
    d.markWorkerStartUnknown(first.dispatch.id, 'remote_start', 'A is uncertain')
    d.updateTaskStatus(task.id, 'ready')
    const replacement = createFederatedStart(d, task.id, 'env-b')
    d.markWorkerStartUnknown(replacement.dispatch.id, 'remote_start', 'B is uncertain')

    expect(
      d.reconcileFederatedWorkerStart({
        dispatchId: first.dispatch.id,
        state: 'ready',
        stage: 'remote_ready'
      })
    ).toMatchObject({ state: 'ready' })
    expect(d.getTask(task.id)?.status).toBe('blocked')
    expect(d.getWorkerDispatch(replacement.dispatch.id)).toMatchObject({ state: 'start_unknown' })
    expect(d.getDispatchContextById(replacement.dispatch.id)).toMatchObject({ status: 'pending' })
  })

  it.each(['failed', 'stopped'] as const)(
    'fails a current blocked task after federated %s reconciliation',
    (state) => {
      const d = createDb()
      const task = d.createTask({ spec: `blocked federated ${state}` })
      const started = createFederatedStart(d, task.id, `env-${state}`)
      d.markWorkerStartUnknown(started.dispatch.id, 'remote_start', 'launch uncertain')

      expect(
        d.reconcileFederatedWorkerStart({
          dispatchId: started.dispatch.id,
          state,
          stage: 'remote_terminal',
          lastError: `remote ${state}`
        })
      ).toMatchObject({ state })
      expect(d.getTask(task.id)).toMatchObject({
        status: 'failed',
        completed_at: expect.any(String)
      })
      expect(d.getDispatchContextById(started.dispatch.id)).toMatchObject({ status: 'failed' })
    }
  )

  it('keeps an active replacement after a stale federated stopped reconciliation', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'stale federated stopped' })
    const first = createFederatedStart(d, task.id, 'env-a')
    d.updateTaskStatus(task.id, 'ready')
    const replacement = createFederatedStart(d, task.id, 'env-b')

    expect(
      d.reconcileFederatedWorkerStart({
        dispatchId: first.dispatch.id,
        state: 'stopped',
        stage: 'remote_stopped',
        lastError: 'late stop'
      })
    ).toMatchObject({ state: 'stopped' })
    expect(d.getTask(task.id)?.status).toBe('dispatched')
    expect(d.getDispatchContextById(replacement.dispatch.id)).toMatchObject({ status: 'pending' })
    expect(d.getDispatchContextById(first.dispatch.id)).toMatchObject({
      status: 'failed',
      failure_count: 0
    })
  })

  it('allows retry only from the Task current terminal Dispatch', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'retry current' })
    const first = d.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })
    d.failWorkerStart(first.dispatch.id, 'agent_readiness', 'first failed')
    const second = d.createStartingWorkerDispatch({
      taskId: task.id,
      retryOf: first.dispatch.id,
      startOptions: {}
    })
    d.failWorkerStart(second.dispatch.id, 'agent_readiness', 'second failed')

    expect(() =>
      d.createStartingWorkerDispatch({
        taskId: task.id,
        retryOf: first.dispatch.id,
        startOptions: {}
      })
    ).toThrow('cannot retry')
    expect(
      d.createStartingWorkerDispatch({
        taskId: task.id,
        retryOf: second.dispatch.id,
        startOptions: {}
      }).worker.state
    ).toBe('starting')
  })

  it('treats abandon of a superseded Dispatch as a no-op', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'stale abandon' })
    const first = d.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })
    d.failWorkerStart(first.dispatch.id, 'agent_readiness', 'first failed')
    const second = d.createStartingWorkerDispatch({
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
    const started = d.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })
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
    const started = d.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })
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
    const started = d.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })
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
