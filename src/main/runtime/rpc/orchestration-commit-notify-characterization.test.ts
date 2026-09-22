import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import { OrchestrationDb } from '../orchestration/db'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationError } from '../orchestration/orchestration-error'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { ORCHESTRATION_METHODS } from './methods/orchestration'
import { createOrchestrationRpcHarness } from './methods/orchestration/rpc-test-harness'

describe('orchestration commit-notify recovery', () => {
  const harness = createOrchestrationRpcHarness()
  const paths: string[] = []

  afterEach(() => {
    harness.cleanup()
    for (const path of paths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  function request(
    rpcId: string,
    mutationId: string,
    method: 'orchestration.send' | 'orchestration.reply',
    params: Record<string, unknown>
  ): RpcRequest {
    return {
      id: rpcId,
      authToken: 'test-token',
      method,
      params,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: mutationId
    }
  }

  function createReadyLocalWorker(
    db: OrchestrationDb,
    taskId: string,
    workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  ) {
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId,
      startOptions: {}
    })
    const capability = db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: workerPaneKey,
      processIncarnation: 'runtime_test:term_worker:1',
      worktreeId: 'repo::worker',
      effects: [],
      setupState: 'not_applicable'
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return { dispatch: db.getDispatchContextById(started.dispatch.id)!, capability }
  }

  async function throwAfterCommitAndReplay(
    dispatcher: RpcDispatcher,
    runtime: OrcaRuntimeService,
    first: RpcRequest,
    retryRpcId: string
  ) {
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementationOnce(() => {
      throw new Error('injected notification failure')
    })

    const failed = await dispatcher.dispatch(first)
    const replayed = await dispatcher.dispatch({ ...first, id: retryRpcId })

    expect(failed).toMatchObject({ ok: false, error: { code: 'runtime_error' } })
    expect(replayed).toMatchObject({
      ok: true,
      result: { mutation: { requestId: first.orchestrationRequestId, replayed: true } }
    })
    return replayed as { result: Record<string, unknown> }
  }

  it('replays one Run send after notification throws post-commit', async () => {
    const { db, runtime, activeRunId } = harness.setup()
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const waiting = runtime.waitForMessage(`run:${activeRunId}`, { timeoutMs: 5_000 })
    const replayed = await throwAfterCommitAndReplay(
      dispatcher,
      runtime,
      request('rpc_run_send', 'mutation_run_send', 'orchestration.send', {
        from: 'term_coord',
        to: `run:${activeRunId}`,
        subject: 'one durable Run message'
      }),
      'rpc_run_send_retry'
    )

    const messages = db.getInbox(100)
    expect(messages).toHaveLength(1)
    expect(replayed.result).toMatchObject({ message: { id: messages[0]?.id } })
    await expect(waiting).resolves.toBe('notified')
  })

  it('replays one Dispatch send after notification throws post-commit', async () => {
    const { db, runtime } = harness.setup()
    const task = db.createTask({ spec: 'Receive exact control mail' })
    const { dispatch } = createReadyLocalWorker(db, task.id)
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const waiting = runtime.waitForMessage(`dispatch:${dispatch.id}`, { timeoutMs: 5_000 })
    const replayed = await throwAfterCommitAndReplay(
      dispatcher,
      runtime,
      request('rpc_dispatch_send', 'mutation_dispatch_send', 'orchestration.send', {
        from: 'term_coord',
        to: `dispatch:${dispatch.id}`,
        subject: 'one durable Dispatch message'
      }),
      'rpc_dispatch_send_retry'
    )

    const messages = db.getUnreadMessages(`dispatch:${dispatch.id}`)
    expect(messages).toHaveLength(1)
    expect(replayed.result).toMatchObject({ message: { id: messages[0]?.id } })
    await expect(waiting).resolves.toBe('notified')
  })

  it('replays one generic reply after notification throws post-commit', async () => {
    const { db, runtime, activeRunId } = harness.setup()
    const original = db.insertMessage({
      from: 'term_worker',
      to: `run:${activeRunId}`,
      subject: 'Need a generic answer',
      runId: activeRunId
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const waiting = runtime.waitForMessage('term_worker', { timeoutMs: 5_000 })
    const replayed = await throwAfterCommitAndReplay(
      dispatcher,
      runtime,
      request('rpc_generic_reply', 'mutation_generic_reply', 'orchestration.reply', {
        id: original.id,
        body: 'One durable answer',
        from: 'term_coord'
      }),
      'rpc_generic_reply_retry'
    )

    const replies = db.getInbox(100).filter((message) => message.thread_id === original.id)
    expect(replies).toHaveLength(1)
    expect(replayed.result).toMatchObject({ message: { id: replies[0]?.id } })
    await expect(waiting).resolves.toBe('notified')
  })

  it('replays one question reply nudge without duplicating the answer', async () => {
    const { db, runtime, activeRunId } = harness.setup()
    if (!activeRunId) {
      throw new Error('active Run missing')
    }
    const task = db.createTask({ spec: 'Ask once', runId: activeRunId })
    const { dispatch } = createReadyLocalWorker(db, task.id)
    const question = db.createQuestion({
      runId: activeRunId,
      dispatchId: dispatch.id,
      askerHandle: 'term_worker',
      question: 'Continue?'
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const waiting = runtime.waitForMessage(`dispatch:${dispatch.id}`, { timeoutMs: 5_000 })
    const replayed = await throwAfterCommitAndReplay(
      dispatcher,
      runtime,
      request('rpc_question_reply', 'mutation_question_reply', 'orchestration.reply', {
        id: question.message.id,
        run: activeRunId,
        body: 'Continue',
        from: 'term_coord'
      }),
      'rpc_question_reply_retry'
    )

    const answered = db.getQuestion(question.message.id)
    expect(answered).toMatchObject({ status: 'answered', answer_body: 'Continue' })
    expect(
      db.getInbox(100).filter((message) => message.thread_id === question.message.id)
    ).toHaveLength(2)
    expect(replayed.result).toMatchObject({ duplicate: false })
    await expect(waiting).resolves.toBe('notified')
  })

  it('replays worker settlement without applying lifecycle state twice', async () => {
    const { db, runtime, activeRunId } = harness.setup()
    const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker'
        ? workerPaneKey
        : handle === 'term_coord'
          ? harness.coordinatorPaneKey
          : null
    )
    const task = db.createTask({ spec: 'Settle once' })
    const { dispatch, capability } = createReadyLocalWorker(db, task.id, workerPaneKey)
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const workerDone = request('rpc_worker_done', 'mutation_worker_done', 'orchestration.send', {
      from: 'term_worker',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({
        taskId: task.id,
        dispatchId: dispatch.id,
        outcome: 'succeeded'
      })
    })
    workerDone.orchestrationCapability = capability
    const waiting = runtime.waitForMessage(`run:${activeRunId}`, {
      typeFilter: ['worker_done'],
      timeoutMs: 5_000
    })
    let waiterSettled = false
    void waiting.then(() => {
      waiterSettled = true
    })
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementationOnce(() => {
      throw new Error('injected notification failure')
    })

    const failed = await dispatcher.dispatch(workerDone)
    await Promise.resolve()
    expect(failed).toMatchObject({ ok: false, error: { code: 'runtime_error' } })
    expect(waiterSettled).toBe(false)

    const replayed = await dispatcher.dispatch({ ...workerDone, id: 'rpc_worker_done_retry' })

    expect(db.getTask(task.id)?.status).toBe('completed')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    expect(db.getInbox(100).filter((message) => message.type === 'worker_done')).toHaveLength(1)
    expect(replayed).toMatchObject({
      ok: true,
      result: {
        lifecycle: { action: 'completed' },
        mutation: { requestId: 'mutation_worker_done', replayed: true }
      }
    })
    await expect(waiting).resolves.toBe('notified')
  })

  it('resumes an effect-free worker_done checkpoint after a runtime restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-worker-done-restart-'))
    paths.push(dir)
    const dbPath = join(dir, 'orchestration.db')
    const db = new OrchestrationDb(dbPath)
    const run = db.createRun({
      objective: 'Resume worker_done',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: harness.coordinatorPaneKey
    })
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_worker'
        ? workerPaneKey
        : handle === 'term_coord'
          ? harness.coordinatorPaneKey
          : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle.startsWith('term_') ? `runtime_test:${handle}:1` : null
    )
    const task = db.createTask({ spec: 'Resume before atomic settlement', runId: run.id })
    const { dispatch, capability } = createReadyLocalWorker(db, task.id, workerPaneKey)
    const workerDone = request(
      'rpc_worker_done_before_crash',
      'mutation_worker_done_before_crash',
      'orchestration.send',
      {
        from: 'term_worker',
        subject: 'Done after restart',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          outcome: 'succeeded'
        })
      }
    )
    workerDone.orchestrationCapability = capability
    vi.spyOn(db, 'commitWorkerDoneMessageMutation').mockImplementationOnce(() => {
      throw new OrchestrationError(
        'operation_unknown',
        'injected process loss before worker_done transaction'
      )
    })

    const firstDispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const interrupted = await firstDispatcher.dispatch(workerDone)
    const callerFingerprint = db.getOrCreateLocalMutationCallerFingerprint()

    expect(interrupted).toMatchObject({ ok: false, error: { code: 'operation_unknown' } })
    expect(
      db.getMutationReceipt(callerFingerprint, 'mutation_worker_done_before_crash')
    ).toMatchObject({ state: 'pending', receipt: expect.stringContaining('effectFree') })
    expect(db.getInbox(100).filter((message) => message.type === 'worker_done')).toHaveLength(0)
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    db.close()

    const restartedDb = new OrchestrationDb(dbPath)
    const restartedRuntime = new OrcaRuntimeService()
    restartedRuntime.setOrchestrationDb(restartedDb)
    vi.spyOn(restartedRuntime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_worker'
        ? workerPaneKey
        : handle === 'term_coord'
          ? harness.coordinatorPaneKey
          : null
    )
    vi.spyOn(restartedRuntime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      restartedRuntime.getTerminalPaneKey(handle)
    )
    vi.spyOn(restartedRuntime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle.startsWith('term_') ? `runtime_test:${handle}:1` : null
    )
    vi.spyOn(restartedRuntime, 'notifyMessageArrived').mockImplementation(() => {})
    const restartedDispatcher = new RpcDispatcher({
      runtime: restartedRuntime,
      methods: ORCHESTRATION_METHODS
    })

    const resumed = await restartedDispatcher.dispatch({
      ...workerDone,
      id: 'rpc_worker_done_after_crash'
    })

    expect(resumed).toMatchObject({
      ok: true,
      result: {
        lifecycle: { action: 'completed' },
        mutation: { requestId: 'mutation_worker_done_before_crash', replayed: true }
      }
    })
    expect(
      restartedDb.getInbox(100).filter((message) => message.type === 'worker_done')
    ).toHaveLength(1)
    expect(restartedDb.getTask(task.id)?.status).toBe('completed')
    expect(restartedDb.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    expect(
      restartedDb
        .getAttemptObservationFacts(dispatch.id)
        .filter((fact) => fact.facet === 'worker_report')
    ).toHaveLength(1)
    expect(
      restartedDb.getMutationReceipt(callerFingerprint, 'mutation_worker_done_before_crash')?.state
    ).toBe('completed')
    restartedDb.close()
  })

  it.each([
    {
      seam: 'lifecycle settlement',
      inject(db: OrchestrationDb) {
        vi.spyOn(db, 'settleWorkerReportInTransaction').mockImplementationOnce(() => {
          throw new Error('injected settlement failure')
        })
      }
    },
    {
      seam: 'mutation receipt',
      inject(db: OrchestrationDb) {
        vi.spyOn(db, 'completeMutationReceipt').mockImplementationOnce(() => {
          throw new Error('injected receipt failure')
        })
      }
    }
  ])('atomically rolls back worker_done when $seam fails', async ({ inject }) => {
    const { db, runtime, activeRunId } = harness.setup()
    const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker'
        ? workerPaneKey
        : handle === 'term_coord'
          ? harness.coordinatorPaneKey
          : null
    )
    const task = db.createTask({ spec: 'Commit report and settlement together' })
    const { dispatch, capability } = createReadyLocalWorker(db, task.id, workerPaneKey)
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const workerDone = request(
      'rpc_atomic_worker_done',
      'mutation_atomic_worker_done',
      'orchestration.send',
      {
        from: 'term_worker',
        subject: 'Done atomically',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          outcome: 'succeeded'
        })
      }
    )
    workerDone.orchestrationCapability = capability
    const callerFingerprint = db.getOrCreateLocalMutationCallerFingerprint()
    inject(db)

    const failed = await dispatcher.dispatch(workerDone)

    expect(failed).toMatchObject({ ok: false, error: { code: 'runtime_error' } })
    expect(db.getInbox(100).filter((message) => message.type === 'worker_done')).toHaveLength(0)
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(
      db.getAttemptObservationFacts(dispatch.id).filter((fact) => fact.facet === 'worker_report')
    ).toHaveLength(0)
    expect(db.getMutationReceipt(callerFingerprint, 'mutation_atomic_worker_done')).toBeUndefined()
    const run = db.getRun(activeRunId!)!
    expect(
      db.getOrCreateRunDelivery({
        runId: activeRunId!,
        consumerGeneration: run.consumer_generation
      })
    ).toBeUndefined()

    const retried = await dispatcher.dispatch({ ...workerDone, id: 'rpc_atomic_worker_done_retry' })

    expect(retried).toMatchObject({
      ok: true,
      result: { lifecycle: { action: 'completed' } }
    })
    expect(db.getInbox(100).filter((message) => message.type === 'worker_done')).toHaveLength(1)
    expect(db.getTask(task.id)?.status).toBe('completed')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    expect(
      db.getAttemptObservationFacts(dispatch.id).filter((fact) => fact.facet === 'worker_report')
    ).toHaveLength(1)
    expect(db.getMutationReceipt(callerFingerprint, 'mutation_atomic_worker_done')?.state).toBe(
      'completed'
    )
  })

  it('replays one federated enqueue after the relay wake throws post-commit', async () => {
    const { db, runtime } = harness.setup()
    const task = db.createTask({ spec: 'Receive federated control mail' })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {},
      federation: {
        environmentId: 'environment_worker',
        environmentName: 'worker',
        peerFingerprint: 'worker-peer',
        protocolVersion: 2
      }
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    vi.spyOn(runtime, 'ensureOrchestrationFederationRelay').mockImplementationOnce(() => {
      throw new Error('injected relay wake failure')
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const first = request('rpc_federated_send', 'mutation_federated_send', 'orchestration.send', {
      from: 'term_coord',
      to: `dispatch:${started.dispatch.id}`,
      subject: 'One durable relay item'
    })

    const failed = await dispatcher.dispatch(first)
    const replayed = await dispatcher.dispatch({ ...first, id: 'rpc_federated_send_retry' })

    expect(failed).toMatchObject({ ok: false, error: { code: 'runtime_error' } })
    expect(replayed).toMatchObject({
      ok: true,
      result: {
        relay: { dispatchId: started.dispatch.id, accepted: true },
        mutation: { requestId: 'mutation_federated_send', replayed: true }
      }
    })
    expect(db.listPendingFederationRelay(started.dispatch.id, 'to_worker')).toHaveLength(1)
  })
})
