import { describe, expect, it, vi } from 'vitest'
import {
  createHomeTask,
  homeDb,
  homeDispatcher,
  homeRuntime,
  setupFederationTestHarness,
  startRequest,
  workerRuntime,
  setWorkerPeerFingerprint,
  ORCHESTRATION_CONTRACT_VERSION
} from './orchestration-federation-test-harness'

describe('orchestration federation worker stop', () => {
  setupFederationTestHarness()

  it('workerStop stops only the exact remote agent terminal', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = homeDb.getDispatchContext(task.id)!

    const stopped = await homeDispatcher.dispatch({
      id: 'rpc_remote_stop',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'request_remote_stop',
      method: 'orchestration.workerStop',
      params: { dispatch: dispatch.id }
    })

    expect(stopped).toMatchObject({
      ok: true,
      result: { state: 'stopped', processAction: 'closed_agent_terminal' }
    })
    expect(workerRuntime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(workerRuntime.closeTerminal).toHaveBeenCalledWith('term_windows_worker')
    expect(homeDb.getTask(task.id)?.status).toBe('blocked')

    vi.mocked(workerRuntime.showTerminal).mockResolvedValue({
      handle: 'term_windows_worker',
      worktreeId: 'repo::windows-worktree',
      connected: false,
      writable: false
    } as never)
    const shown = await homeDispatcher.dispatch({
      id: 'rpc_remote_show_after_stop',
      authToken: 'coordinator-token',
      method: 'orchestration.workerShow',
      params: { dispatch: dispatch.id }
    })
    expect(shown).toMatchObject({
      ok: true,
      result: { observation: { status: 'exited', exactWorker: true } }
    })
  })

  it('stale worker stop preserves completed replacement (federated)', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    const first = homeDb.getDispatchContext(task.id)!
    const dependent = homeDb.createTask({
      spec: 'federated dependent',
      deps: [task.id],
      runId: task.run_id
    })
    homeDb.updateTaskStatus(task.id, 'ready')
    const replacement = homeDb.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {}
    })
    homeDb.markWorkerDispatchReady(replacement.dispatch.id)
    homeDb.settleWorkerReport({
      taskId: task.id,
      dispatchId: replacement.dispatch.id,
      outcome: 'succeeded',
      result: 'federated replacement complete'
    })
    const taskBefore = homeDb.getTask(task.id)
    const replacementBefore = homeDb.getDispatchContextById(replacement.dispatch.id)
    const dependentBefore = homeDb.getTask(dependent.id)
    const rawDb = (
      homeDb as unknown as {
        db: { prepare(sql: string): { run(...args: unknown[]): void } }
      }
    ).db
    rawDb.prepare("UPDATE dispatch_contexts SET status = 'dispatched' WHERE id = ?").run(first.id)
    vi.spyOn(homeRuntime, 'callOrchestrationWorkerServer').mockResolvedValue({
      dispatchId: first.id,
      state: 'succeeded',
      alreadySettled: true,
      processAction: 'none'
    } as never)

    const stopped = await homeDispatcher.dispatch({
      id: 'rpc_stale_replacement_stop',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'request_stale_replacement_stop',
      method: 'orchestration.workerStop',
      params: { dispatch: first.id }
    })

    expect(stopped).toMatchObject({ ok: true, result: { state: 'ready', processAction: 'none' } })
    expect(homeDb.getWorkerDispatch(first.id)).toMatchObject({
      state: 'ready',
      stage: 'remote_report_pending'
    })
    expect(homeDb.getDispatchContextById(first.id)).toMatchObject({
      status: 'dispatched',
      completed_at: expect.any(String),
      capability_revoked_at: expect.any(String),
      failure_count: 0
    })
    expect(homeDb.getTask(task.id)).toMatchObject({
      status: 'completed',
      result: 'federated replacement complete',
      completed_at: taskBefore?.completed_at
    })
    expect(homeDb.getDispatchContextById(replacement.dispatch.id)).toMatchObject({
      status: 'completed',
      completed_at: replacementBefore?.completed_at
    })
    expect(homeDb.getTask(dependent.id)).toEqual(dependentBefore)
  })

  it('workerStop rejects a re-paired server before show or stop effects', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = homeDb.getDispatchContext(task.id)!
    setWorkerPeerFingerprint('replacement_windows_peer')

    const shown = await homeDispatcher.dispatch({
      id: 'rpc_changed_peer_show',
      authToken: 'coordinator-token',
      method: 'orchestration.workerShow',
      params: { dispatch: dispatch.id }
    })
    const stopped = await homeDispatcher.dispatch({
      id: 'rpc_changed_peer_stop',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'request_changed_peer_stop',
      method: 'orchestration.workerStop',
      params: { dispatch: dispatch.id }
    })

    expect(shown).toMatchObject({ ok: false, error: { code: 'peer_changed' } })
    expect(stopped).toMatchObject({ ok: false, error: { code: 'peer_changed' } })
    expect(homeDb.getWorkerDispatch(dispatch.id)?.state).toBe('ready')
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })

  it('workerStop returns stop_unknown when the worker server disconnects after the home fence', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = homeDb.getDispatchContext(task.id)!
    vi.spyOn(homeRuntime, 'callOrchestrationWorkerServer').mockRejectedValueOnce(
      new Error('connection lost')
    )

    const stopped = await homeDispatcher.dispatch({
      id: 'rpc_disconnected_stop',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'request_disconnected_stop',
      method: 'orchestration.workerStop',
      params: { dispatch: dispatch.id }
    })

    expect(stopped).toMatchObject({
      ok: true,
      result: { state: 'stop_unknown', processAction: 'unknown' }
    })
    expect(homeDb.getTask(task.id)?.status).toBe('blocked')
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })

  it('workerStop never reads or closes a same-looking replacement process', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = homeDb.getDispatchContext(task.id)!
    vi.mocked(workerRuntime.getTerminalProcessIncarnation).mockReturnValue(
      'windows_runtime:pty:replacement'
    )

    const read = await homeDispatcher.dispatch({
      id: 'rpc_replacement_read',
      authToken: 'coordinator-token',
      method: 'orchestration.workerRead',
      params: { dispatch: dispatch.id }
    })
    const stopped = await homeDispatcher.dispatch({
      id: 'rpc_replacement_stop',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'request_replacement_stop',
      method: 'orchestration.workerStop',
      params: { dispatch: dispatch.id }
    })

    expect(read).toMatchObject({
      ok: false,
      error: { code: 'worker_identity_changed' }
    })
    expect(stopped).toMatchObject({
      ok: true,
      result: { state: 'stop_unknown', processAction: 'none' }
    })
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })
})
