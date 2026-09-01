import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { OrchestrationDb } from '../../orchestration/db'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/environment-transport'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { ORCHESTRATION_METHODS } from './orchestration'
import { createFederationWorkerStartRequest } from './orchestration-federation-test-request'

describe('federated worker disposition barrier', () => {
  let homeDb: OrchestrationDb
  let workerDb: OrchestrationDb
  let homeRuntime: OrcaRuntimeService
  let workerRuntime: OrcaRuntimeService
  let homeDispatcher: RpcDispatcher
  let workerDispatcher: RpcDispatcher

  beforeEach(() => {
    homeDb = new OrchestrationDb(':memory:')
    workerDb = new OrchestrationDb(':memory:')
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    workerDispatcher = new RpcDispatcher({ runtime: workerRuntime, methods: ORCHESTRATION_METHODS })
    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => ({
        environmentId: 'environment_windows',
        name: 'windows',
        peerFingerprint: 'windows_peer_fingerprint'
      }),
      call: async (_selector, method, params, _timeoutMs, envelope) => {
        if (method === 'status.get') {
          return {
            id: 'status',
            ok: true,
            result: workerRuntime.getStatus(),
            _meta: { runtimeId: workerRuntime.getRuntimeId() }
          }
        }
        return (await workerDispatcher.dispatch({
          id: `remote_${method}`,
          authToken: 'run-home-device-token',
          method,
          params,
          orchestrationContractVersion: envelope?.orchestrationContractVersion,
          orchestrationRequestId: envelope?.orchestrationRequestId,
          orchestrationCapability: envelope?.orchestrationCapability
        })) as RuntimeRpcResponse<unknown>
      }
    }
    homeRuntime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    homeRuntime.setOrchestrationDb(homeDb)
    homeDispatcher = new RpcDispatcher({ runtime: homeRuntime, methods: ORCHESTRATION_METHODS })
    vi.spyOn(homeRuntime, 'getTerminalPaneKey').mockReturnValue(
      'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
    configureWorkerRuntime()
  })

  afterEach(() => {
    homeRuntime.stopOrchestrationFederationRelay()
    homeDb.close()
    workerDb.close()
  })

  function configureWorkerRuntime(): void {
    vi.spyOn(workerRuntime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(workerRuntime, 'showRepo').mockResolvedValue({
      id: 'windows-repo',
      kind: 'git'
    } as never)
    vi.spyOn(workerRuntime, 'createManagedWorktree').mockResolvedValue({
      worktree: { id: 'repo::windows-worktree', repoId: 'repo' },
      startupTerminal: { spawned: true, handle: 'term_windows_worker' },
      setupReceipt: {
        requested: 'run',
        hookFound: true,
        startupPolicy: 'start-immediately',
        state: 'running'
      }
    } as never)
    vi.spyOn(workerRuntime, 'listTerminals').mockResolvedValue({
      terminals: [{ handle: 'term_windows_worker', title: 'Pi' }],
      totalCount: 1,
      truncated: false
    } as never)
    vi.spyOn(workerRuntime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_windows_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(workerRuntime, 'getTerminalPaneKey').mockReturnValue(
      'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    )
    vi.spyOn(workerRuntime, 'getTerminalProcessIncarnation').mockReturnValue(
      'windows_runtime:pty:1'
    )
    vi.spyOn(workerRuntime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(workerRuntime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_windows_worker',
      accepted: true,
      bytesWritten: 1
    })
  }

  function homeCall(id: string, method: string, params: Record<string, unknown>) {
    return homeDispatcher.dispatch({
      id,
      authToken: 'run-home-device-token',
      method,
      params,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: `${id}_request`
    })
  }

  it('persists disposition at the Run home without closing the remote terminal', async () => {
    const run = homeDb.createRun({
      objective: 'Mac to Windows',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = homeDb.createTask({ spec: 'Audit Windows behavior', runId: run.id })
    await homeDispatcher.dispatch(createFederationWorkerStartRequest(task.id))
    homeRuntime.stopOrchestrationFederationRelay()
    const dispatch = homeDb.getDispatchContext(task.id)!
    const prompt = vi.mocked(workerRuntime.sendTerminalAgentPrompt).mock.calls[0]?.[1] ?? ''
    const capability = prompt.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
    const completion = workerDispatcher.dispatch({
      id: 'rpc_federated_worker_done',
      authToken: 'worker-local-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'federated_worker_done_request',
      orchestrationCapability: capability,
      method: 'orchestration.send',
      params: {
        from: 'term_windows_worker',
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          outcome: 'succeeded'
        })
      }
    })
    await vi.waitFor(() =>
      expect(workerDb.listPendingFederationRelay(dispatch.id, 'to_home')).toHaveLength(1)
    )
    await homeRuntime.syncOrchestrationFederatedDispatch(dispatch.id)
    await expect(completion).resolves.toMatchObject({
      ok: true,
      result: { lifecycle: { action: 'completed', authority: 'run_home' } }
    })

    const checked = await homeCall('rpc_federated_check', 'orchestration.check', {
      terminal: 'term_coord'
    })
    expect(checked).toMatchObject({ ok: true, result: { messages: [{ type: 'worker_done' }] } })
    const deliveryId = (checked as { ok: true; result: { deliveryId: string } }).result.deliveryId
    await expect(
      homeCall('rpc_federated_ack', 'orchestration.check', {
        terminal: 'term_coord',
        ack: deliveryId
      })
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'worker_disposition_required',
        data: { dispatchIds: [dispatch.id] }
      }
    })

    const closeTerminal = vi.spyOn(homeRuntime, 'closeTerminal')
    await expect(
      homeCall('rpc_federated_release', 'orchestration.workerRelease', {
        dispatch: dispatch.id
      })
    ).resolves.toMatchObject({
      ok: true,
      result: { state: 'retained', reason: 'federation_unsupported', processAction: 'none' }
    })
    expect(closeTerminal).not.toHaveBeenCalled()
    await expect(
      homeCall('rpc_federated_final_ack', 'orchestration.check', {
        terminal: 'term_coord',
        ack: deliveryId
      })
    ).resolves.toMatchObject({ ok: true, result: { acknowledged: deliveryId } })

    const retainedResource = homeDb.getWorkerTerminalResourceByOwner(dispatch.id)!
    homeDb.db
      .prepare("UPDATE worker_terminal_resources SET release_state = 'released' WHERE id = ?")
      .run(retainedResource.id)
    await expect(
      homeCall('rpc_federated_release_again', 'orchestration.workerRelease', {
        dispatch: dispatch.id
      })
    ).resolves.toMatchObject({
      ok: true,
      result: { state: 'already_released', processAction: 'none' }
    })

    const pendingTask = homeDb.createTask({ spec: 'Release before handle', runId: run.id })
    await homeDispatcher.dispatch({
      ...createFederationWorkerStartRequest(pendingTask.id),
      id: 'rpc_pending_worker_start',
      orchestrationRequestId: 'request_pending_worker'
    })
    const pendingDispatch = homeDb.getDispatchContext(pendingTask.id)!
    homeDb.db
      .prepare(
        'UPDATE federated_dispatches SET remote_terminal_handle = NULL WHERE dispatch_id = ?'
      )
      .run(pendingDispatch.id)
    homeDb.db
      .prepare('UPDATE worker_dispatches SET agent_terminal_handle = NULL WHERE dispatch_id = ?')
      .run(pendingDispatch.id)
    await expect(
      homeCall('rpc_federated_release_without_handle', 'orchestration.workerRelease', {
        dispatch: pendingDispatch.id
      })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        state: 'retained',
        reason: 'federation_unsupported',
        processAction: 'none',
        archive: null
      }
    })
    expect(homeDb.getWorkerTerminalResourceByOwner(pendingDispatch.id)).toBeUndefined()
    expect(closeTerminal).not.toHaveBeenCalled()
  })
})
