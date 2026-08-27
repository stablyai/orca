import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/environment-transport'
import { RpcDispatcher } from '../dispatcher'
import { ORCHESTRATION_METHODS } from './orchestration'
import { createFederationWorkerStartRequest as startRequest } from './orchestration-federation-test-request'

describe('orchestration federation ambiguous starts', () => {
  let homeDb: OrchestrationDb
  let workerDb: OrchestrationDb
  let homeRuntime: OrcaRuntimeService
  let workerRuntime: OrcaRuntimeService
  let homeDispatcher: RpcDispatcher
  let workerDispatcher: RpcDispatcher
  let failNextAttachAfterDelivery: boolean

  beforeEach(() => {
    homeDb = new OrchestrationDb(':memory:')
    workerDb = new OrchestrationDb(':memory:')
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    workerDispatcher = new RpcDispatcher({ runtime: workerRuntime, methods: ORCHESTRATION_METHODS })
    failNextAttachAfterDelivery = false
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
        const response = (await workerDispatcher.dispatch({
          id: `remote_${method}`,
          authToken: 'run-home-device-token',
          method,
          params,
          orchestrationContractVersion: envelope?.orchestrationContractVersion,
          orchestrationRequestId: envelope?.orchestrationRequestId,
          orchestrationCapability: envelope?.orchestrationCapability
        })) as RuntimeRpcResponse<unknown>
        if (method === 'orchestration.federationAttachStart' && failNextAttachAfterDelivery) {
          failNextAttachAfterDelivery = false
          throw new Error('connection lost after remote attachment')
        }
        return response
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
      terminals: [{ handle: 'term_windows_worker', title: 'Codex' }],
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

  function createHomeTask() {
    const run = homeDb.createRun({
      objective: 'Mac to Windows',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    return homeDb.createTask({ spec: 'Audit Windows behavior', runId: run.id })
  }

  function dispatchRemoteCompletion(taskId: string, dispatchId: string, requestId: string) {
    const prompt = vi.mocked(workerRuntime.sendTerminalAgentPrompt).mock.calls[0]?.[1] ?? ''
    const capability = prompt.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
    return workerDispatcher.dispatch({
      id: `rpc_${requestId}`,
      authToken: 'worker-local-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: requestId,
      orchestrationCapability: capability,
      method: 'orchestration.send',
      params: {
        from: 'term_windows_worker',
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
      }
    })
  }

  it('keeps an unobserved remote Enter fenced and accepts its late worker report', async () => {
    vi.mocked(workerRuntime.sendTerminalAgentPrompt).mockRejectedValueOnce(
      new Error('agent_prompt_stalled')
    )
    const task = createHomeTask()

    const started = await homeDispatcher.dispatch(startRequest(task.id))
    homeRuntime.stopOrchestrationFederationRelay()
    expect(started).toMatchObject({
      ok: true,
      result: { state: 'outcome_unknown', failedStage: 'dispatch_input' }
    })
    const dispatch = homeDb.getDispatchContext(task.id)!
    expect(homeDb.getTask(task.id)?.status).toBe('blocked')
    expect(homeDb.getDispatchContextById(dispatch.id)).toMatchObject({
      status: 'pending',
      capability_revoked_at: null
    })
    expect(homeDb.getWorkerDispatch(dispatch.id)).toMatchObject({
      state: 'start_unknown',
      stage: 'dispatch_input'
    })
    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)).toMatchObject({
      state: 'start_unknown',
      stage: 'dispatch_input',
      last_error: 'agent_prompt_stalled',
      capability_hash: expect.any(String)
    })

    const sent = dispatchRemoteCompletion(task.id, dispatch.id, 'stalled_remote_late_completion')
    await vi.waitFor(() =>
      expect(workerDb.listPendingFederationRelay(dispatch.id, 'to_home')).toHaveLength(1)
    )
    await homeRuntime.syncOrchestrationFederatedDispatch(dispatch.id)

    await expect(sent).resolves.toMatchObject({
      ok: true,
      result: { lifecycle: { action: 'completed', authority: 'run_home' } }
    })
    expect(homeDb.getTask(task.id)?.status).toBe('completed')
    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)).toMatchObject({
      state: 'succeeded',
      stage: 'worker_report_settled',
      capability_hash: null
    })
  })

  it('accepts a late report after the remote attachment response is lost', async () => {
    failNextAttachAfterDelivery = true
    const task = createHomeTask()

    const started = await homeDispatcher.dispatch(startRequest(task.id))
    homeRuntime.stopOrchestrationFederationRelay()
    expect(started).toMatchObject({
      ok: true,
      result: { state: 'outcome_unknown', failedStage: 'remote_attach' }
    })
    const dispatch = homeDb.getDispatchContext(task.id)!
    expect(homeDb.getWorkerDispatch(dispatch.id)).toMatchObject({
      state: 'start_unknown',
      stage: 'remote_attach'
    })
    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)?.state).toBe('ready')

    const sent = dispatchRemoteCompletion(task.id, dispatch.id, 'lost_attach_late_completion')
    await vi.waitFor(() =>
      expect(workerDb.listPendingFederationRelay(dispatch.id, 'to_home')).toHaveLength(1)
    )
    await homeRuntime.syncOrchestrationFederatedDispatch(dispatch.id)

    await expect(sent).resolves.toMatchObject({
      ok: true,
      result: { lifecycle: { action: 'completed', authority: 'run_home' } }
    })
    expect(homeDb.getTask(task.id)?.status).toBe('completed')
    expect(homeDb.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)?.state).toBe('succeeded')
  })
})
