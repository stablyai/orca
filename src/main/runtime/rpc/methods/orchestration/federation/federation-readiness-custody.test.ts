import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../../../shared/runtime-rpc-envelope'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import type { OrchestrationEnvironmentTransport } from '../../../../orchestration/environment-transport'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { createFederationWorkerStartRequest } from './federation-request.test-support'
import { configureFederationWorkerRuntime } from './federation-runtime.test-support'

describe('federated readiness custody', () => {
  let homeDb: OrchestrationDb
  let workerDb: OrchestrationDb
  let homeRuntime: OrcaRuntimeService
  let workerRuntime: OrcaRuntimeService
  let homeDispatcher: RpcDispatcher

  beforeEach(() => {
    homeDb = new OrchestrationDb(':memory:')
    workerDb = new OrchestrationDb(':memory:')
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    configureFederationWorkerRuntime(workerRuntime)
    const workerDispatcher = new RpcDispatcher({
      runtime: workerRuntime,
      methods: ORCHESTRATION_METHODS
    })
    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => ({
        environmentId: 'environment_windows',
        name: 'windows',
        peerFingerprint: 'windows_peer_fingerprint',
        pairingRevision: 73
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
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: RpcDispatcher returns the transport envelope required by this adapter.
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
  })

  afterEach(() => {
    homeRuntime.stopOrchestrationFederationRelay()
    homeDb.close()
    workerDb.close()
  })

  it('preserves paired-runtime custody when startup readiness is unsupported', async () => {
    vi.mocked(workerRuntime.waitForTerminal).mockResolvedValueOnce({
      handle: 'term_windows_worker',
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      exitCode: null,
      readiness: { state: 'unsupported', source: 'capability', agent: 'codex' }
    })
    const run = homeDb.createRun({
      objective: 'Mac to Windows',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = homeDb.createTask({ spec: 'Audit Windows behavior', runId: run.id })

    const response = await homeDispatcher.dispatch(createFederationWorkerStartRequest(task.id))

    expect(response).toMatchObject({
      ok: true,
      result: {
        state: 'outcome_unknown',
        stage: 'agent_readiness',
        terminalHandle: 'term_windows_worker'
      }
    })
    const dispatch = homeDb.getDispatchContext(task.id)
    expect(dispatch).toBeDefined()
    if (!dispatch) {
      return
    }
    expect(homeDb.getTask(task.id)?.status).toBe('blocked')
    expect(homeDb.getWorkerDispatch(dispatch.id)).toMatchObject({
      state: 'start_unknown',
      worktree_id: 'repo::windows-worktree',
      agent_terminal_handle: 'term_windows_worker'
    })
    expect(homeDb.getFederatedDispatch(dispatch.id)).toMatchObject({
      remote_runtime_epoch: workerRuntime.getRuntimeId(),
      remote_worktree_id: 'repo::windows-worktree',
      remote_terminal_handle: 'term_windows_worker'
    })
    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)).toMatchObject({
      state: 'start_unknown',
      stage: 'agent_readiness',
      worktree_id: 'repo::windows-worktree',
      terminal_handle: 'term_windows_worker',
      capability_hash: expect.any(String)
    })
    expect(workerRuntime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })
})
