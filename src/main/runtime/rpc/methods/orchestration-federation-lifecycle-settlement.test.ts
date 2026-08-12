import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/environment-transport'
import { waitForFederatedLifecycleSettlement } from '../../orchestration/federation-lifecycle-settlement'
import { RpcDispatcher } from '../dispatcher'
import { ORCHESTRATION_METHODS } from './orchestration'
import { createFederationWorkerStartRequest as startRequest } from './orchestration-federation-test-request'

describe('orchestration federation lifecycle settlement', () => {
  let homeDb: OrchestrationDb
  let workerDb: OrchestrationDb
  let homeRuntime: OrcaRuntimeService
  let workerRuntime: OrcaRuntimeService
  let homeDispatcher: RpcDispatcher
  let workerDispatcher: RpcDispatcher
  let workerCapabilities: string[]
  let failNextAckBeforeDelivery: boolean

  beforeEach(() => {
    homeDb = new OrchestrationDb(':memory:')
    workerDb = new OrchestrationDb(':memory:')
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    workerDispatcher = new RpcDispatcher({ runtime: workerRuntime, methods: ORCHESTRATION_METHODS })
    workerCapabilities = [...(workerRuntime.getStatus().capabilities ?? [])]
    failNextAckBeforeDelivery = false
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
            result: { ...workerRuntime.getStatus(), capabilities: workerCapabilities },
            _meta: { runtimeId: workerRuntime.getRuntimeId() }
          }
        }
        if (method === 'orchestration.federationAck' && failNextAckBeforeDelivery) {
          failNextAckBeforeDelivery = false
          throw new Error('connection lost before acknowledgment')
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

  async function sendRemoteCompletion(taskId: string, reportedTaskId: string, sync = true) {
    await homeDispatcher.dispatch(startRequest(taskId))
    homeRuntime.stopOrchestrationFederationRelay()
    const dispatch = homeDb.getDispatchContext(taskId)!
    const prompt = vi.mocked(workerRuntime.sendTerminalAgentPrompt).mock.calls[0]?.[1] ?? ''
    const capability = prompt.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
    const sent = workerDispatcher.dispatch({
      id: 'rpc_waiting_worker_done',
      authToken: 'worker-local-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'waiting_worker_done_request',
      orchestrationCapability: capability,
      method: 'orchestration.send',
      params: {
        from: 'term_windows_worker',
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: reportedTaskId,
          dispatchId: dispatch.id,
          outcome: 'succeeded'
        })
      }
    })
    await vi.waitFor(() =>
      expect(workerDb.listPendingFederationRelay(dispatch.id, 'to_home')).toHaveLength(1)
    )
    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)?.state).toBe('ready')
    if (sync) {
      await homeRuntime.syncOrchestrationFederation()
    }
    return { sent, dispatch }
  }

  it('waits for Run-home settlement when an older CLI omits the wait hint', async () => {
    const task = createHomeTask()

    const { sent, dispatch } = await sendRemoteCompletion(task.id, task.id)

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

  it('returns a Run-home rejection for a mismatched remote task', async () => {
    const task = createHomeTask()

    const { sent } = await sendRemoteCompletion(task.id, 'task_wrong')

    await expect(sent).resolves.toMatchObject({
      ok: true,
      result: {
        lifecycle: {
          action: 'rejected',
          code: 'task_dispatch_mismatch',
          authority: 'run_home'
        }
      }
    })
    expect(homeDb.getTask(task.id)?.status).toBe('dispatched')
  })

  it('rejects before queueing when the negotiated protocol lacks settlement verdicts', async () => {
    workerCapabilities = workerCapabilities.filter(
      (capability) =>
        capability !== ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY
    )
    const task = createHomeTask()

    await homeDispatcher.dispatch(startRequest(task.id))
    homeRuntime.stopOrchestrationFederationRelay()
    const dispatch = homeDb.getDispatchContext(task.id)!
    const prompt = vi.mocked(workerRuntime.sendTerminalAgentPrompt).mock.calls[0]?.[1] ?? ''
    const capability = prompt.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]

    await expect(
      workerDispatcher.dispatch({
        id: 'rpc_unsupported_worker_done',
        authToken: 'worker-local-token',
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: 'unsupported_worker_done_request',
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
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'capability_unsupported' }
    })
    expect(workerDb.listPendingFederationRelay(dispatch.id, 'to_home')).toEqual([])
    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)?.protocol_version).toBe(2)
  })

  it('does not settle an attachment from a verdict for non-lifecycle mail', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    homeRuntime.stopOrchestrationFederationRelay()
    const dispatch = homeDb.getDispatchContext(task.id)!
    const relay = workerDb.enqueueFederationRelay({
      dispatchId: dispatch.id,
      direction: 'to_home',
      kind: 'status',
      payload: '{}'
    })

    await expect(
      workerDispatcher.dispatch({
        id: 'rpc_unrelated_settlement',
        authToken: 'run-home-device-token',
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: 'unrelated_settlement_request',
        method: 'orchestration.federationAck',
        params: {
          dispatchId: dispatch.id,
          throughSequence: relay.sequence,
          settlements: [
            {
              sequence: relay.sequence,
              lifecycle: { action: 'completed', authority: 'run_home' }
            }
          ]
        }
      })
    ).resolves.toMatchObject({ ok: false, error: { code: 'request_mismatch' } })
    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)?.state).toBe('ready')
    expect(workerDb.listPendingFederationRelay(dispatch.id, 'to_home')).toHaveLength(1)
  })

  it('does not settle an attachment from a verdict that contradicts the queued outcome', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    homeRuntime.stopOrchestrationFederationRelay()
    const dispatch = homeDb.getDispatchContext(task.id)!
    const relay = workerDb.enqueueFederationRelay({
      dispatchId: dispatch.id,
      direction: 'to_home',
      kind: 'worker_done',
      payload: JSON.stringify({
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          outcome: 'failed'
        })
      })
    })

    await expect(
      workerDispatcher.dispatch({
        id: 'rpc_contradictory_settlement',
        authToken: 'run-home-device-token',
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: 'contradictory_settlement_request',
        method: 'orchestration.federationAck',
        params: {
          dispatchId: dispatch.id,
          throughSequence: relay.sequence,
          settlements: [
            {
              sequence: relay.sequence,
              lifecycle: { action: 'completed', authority: 'run_home' }
            }
          ]
        }
      })
    ).resolves.toMatchObject({ ok: false, error: { code: 'request_mismatch' } })
    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)?.state).toBe('ready')
    expect(workerDb.listPendingFederationRelay(dispatch.id, 'to_home')).toHaveLength(1)
  })

  it('returns operation_unknown when Run-home settlement waiting is aborted', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    homeRuntime.stopOrchestrationFederationRelay()
    const dispatch = homeDb.getDispatchContext(task.id)!
    const prompt = vi.mocked(workerRuntime.sendTerminalAgentPrompt).mock.calls[0]?.[1] ?? ''
    const capability = prompt.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
    const controller = new AbortController()
    const sent = workerDispatcher.dispatch(
      {
        id: 'rpc_aborted_worker_done',
        authToken: 'worker-local-token',
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: 'aborted_worker_done_request',
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
      },
      { signal: controller.signal }
    )
    await vi.waitFor(() =>
      expect(workerDb.listPendingFederationRelay(dispatch.id, 'to_home')).toHaveLength(1)
    )

    controller.abort()

    await expect(sent).resolves.toMatchObject({
      ok: false,
      error: { code: 'operation_unknown' }
    })
  })

  it('does not register a waiter for an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const addEventListener = vi.spyOn(controller.signal, 'addEventListener')

    await expect(
      waitForFederatedLifecycleSettlement(workerRuntime, 'ctx_aborted', 1, {
        timeoutMs: 0,
        signal: controller.signal
      })
    ).resolves.toBeUndefined()
    expect(addEventListener).not.toHaveBeenCalled()
  })

  it('replays a committed settlement after the first acknowledgment is lost', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    homeRuntime.stopOrchestrationFederationRelay()
    const dispatch = homeDb.getDispatchContext(task.id)!
    const prompt = vi.mocked(workerRuntime.sendTerminalAgentPrompt).mock.calls[0]?.[1] ?? ''
    const capability = prompt.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
    const sent = workerDispatcher.dispatch({
      id: 'rpc_replayed_worker_done',
      authToken: 'worker-local-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'replayed_worker_done_request',
      orchestrationCapability: capability,
      method: 'orchestration.send',
      params: {
        from: 'term_windows_worker',
        subject: 'Done',
        type: 'worker_done',
        waitForLifecycleSettlement: true,
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
    failNextAckBeforeDelivery = true

    await expect(homeRuntime.syncOrchestrationFederatedDispatch(dispatch.id)).rejects.toThrow(
      'connection lost before acknowledgment'
    )
    expect(homeDb.getTask(task.id)?.status).toBe('completed')
    await homeRuntime.syncOrchestrationFederatedDispatch(dispatch.id)

    await expect(sent).resolves.toMatchObject({
      ok: true,
      result: { lifecycle: { action: 'completed', authority: 'run_home' } }
    })
    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)).toMatchObject({
      state: 'succeeded',
      stage: 'worker_report_settled',
      capability_hash: null
    })
  })

  it('replays a rejection without mutating its durable message twice', async () => {
    const task = createHomeTask()
    const { sent, dispatch } = await sendRemoteCompletion(task.id, 'task_wrong', false)
    failNextAckBeforeDelivery = true

    await expect(homeRuntime.syncOrchestrationFederatedDispatch(dispatch.id)).rejects.toThrow(
      'connection lost before acknowledgment'
    )
    const [relay] = workerDb.listPendingFederationRelay(dispatch.id, 'to_home')
    const firstMessage = homeDb.getMessageById(relay.message_id)
    await homeRuntime.syncOrchestrationFederatedDispatch(dispatch.id)

    await expect(sent).resolves.toMatchObject({
      ok: true,
      result: {
        lifecycle: {
          action: 'rejected',
          code: 'task_dispatch_mismatch',
          authority: 'run_home'
        }
      }
    })
    expect(homeDb.getMessageById(relay.message_id)).toMatchObject({
      subject: firstMessage?.subject,
      body: firstMessage?.body,
      payload: firstMessage?.payload
    })
    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)?.state).toBe('ready')
  })
})
