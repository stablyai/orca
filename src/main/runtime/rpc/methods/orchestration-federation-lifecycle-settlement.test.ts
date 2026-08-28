import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY,
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
  let ackAttempts: number
  let transport: OrchestrationEnvironmentTransport

  beforeEach(() => {
    homeDb = new OrchestrationDb(':memory:')
    workerDb = new OrchestrationDb(':memory:')
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    workerDispatcher = new RpcDispatcher({ runtime: workerRuntime, methods: ORCHESTRATION_METHODS })
    workerCapabilities = [...(workerRuntime.getStatus().capabilities ?? [])]
    failNextAckBeforeDelivery = false
    ackAttempts = 0
    transport = {
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
        if (method === 'orchestration.federationAck') {
          ackAttempts += 1
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

  function restartHomeRuntime(): void {
    homeRuntime.stopOrchestrationFederationRelay()
    homeRuntime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    homeRuntime.setOrchestrationDb(homeDb)
  }

  function restartWorkerRuntime(): void {
    workerRuntime.stopOrchestrationFederationRelay()
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    workerDispatcher = new RpcDispatcher({ runtime: workerRuntime, methods: ORCHESTRATION_METHODS })
    configureWorkerRuntime()
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

  function dispatchRemoteCompletion(
    taskId: string,
    dispatchId: string,
    requestId: string,
    signal?: AbortSignal,
    outcome: 'succeeded' | 'failed' = 'succeeded'
  ) {
    const prompt = vi.mocked(workerRuntime.sendTerminalAgentPrompt).mock.calls[0]?.[1] ?? ''
    const capability = prompt.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
    return workerDispatcher.dispatch(
      {
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
          payload: JSON.stringify({ taskId, dispatchId, outcome })
        }
      },
      { signal }
    )
  }

  function lifecycleResult(response: RuntimeRpcResponse<unknown>): string {
    if (!response.ok) {
      return `error:${response.error.code}`
    }
    const result = response.result as { lifecycle?: { action?: string } }
    return result.lifecycle?.action ?? 'missing'
  }

  function legacyWorkerCapabilities(protocolVersion: 1 | 2): string[] {
    return workerCapabilities.filter(
      (capability) =>
        capability !== ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY &&
        (protocolVersion === 2 ||
          capability !== ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY)
    )
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

  it.each([
    [1, 'succeeded'],
    [1, 'failed'],
    [2, 'succeeded'],
    [2, 'failed']
  ] as const)(
    'runs a protocol v%s client through %s completion on a current worker server',
    async (protocolVersion, outcome) => {
      workerCapabilities = legacyWorkerCapabilities(protocolVersion)
      const task = createHomeTask()

      const started = await homeDispatcher.dispatch(startRequest(task.id))
      homeRuntime.stopOrchestrationFederationRelay()
      expect(started).toMatchObject({ ok: true })
      const dispatch = homeDb.getDispatchContext(task.id)!
      expect(workerDb.getRemoteDispatchAttachment(dispatch.id)?.protocol_version).toBe(
        protocolVersion
      )

      const completed = (await dispatchRemoteCompletion(
        task.id,
        dispatch.id,
        `protocol_${protocolVersion}_${outcome}_completion`,
        undefined,
        outcome
      )) as RuntimeRpcResponse<unknown>
      await homeRuntime.syncOrchestrationFederatedDispatch(dispatch.id)

      expect(completed).toMatchObject({
        ok: true,
        result: {
          lifecycle: {
            action: outcome === 'succeeded' ? 'completed' : 'failed',
            authority: 'worker_server_legacy'
          }
        }
      })
      expect({
        task: homeDb.getTask(task.id)?.status,
        dispatch: homeDb.getDispatchContextById(dispatch.id)?.status,
        attachment: workerDb.getRemoteDispatchAttachment(dispatch.id)?.state,
        pending: workerDb.listPendingFederationRelay(dispatch.id, 'to_home').length,
        worktreeCreates: vi.mocked(workerRuntime.createManagedWorktree).mock.calls.length,
        promptWrites: vi.mocked(workerRuntime.sendTerminalAgentPrompt).mock.calls.length
      }).toEqual({
        task: outcome === 'succeeded' ? 'completed' : 'failed',
        dispatch: outcome === 'succeeded' ? 'completed' : 'failed',
        attachment: outcome,
        pending: 0,
        worktreeCreates: 1,
        promptWrites: 1
      })
    }
  )

  it.each([1, 2] as const)(
    'settles a protocol v%s report from a legacy worker server',
    async (protocolVersion) => {
      const legacyCapabilities = legacyWorkerCapabilities(protocolVersion)
      let attachProtocol: number | undefined
      let legacyItems: unknown[] = []
      let acknowledgment: Record<string, unknown> | undefined
      vi.spyOn(homeRuntime, 'callOrchestrationWorkerServer').mockImplementation(
        async (_environmentId, method, params) => {
          if (method === 'status.get') {
            return { ...workerRuntime.getStatus(), capabilities: legacyCapabilities }
          }
          if (method === 'orchestration.federationAttachStart') {
            const input = params as { dispatchId: string; protocolVersion: number }
            attachProtocol = input.protocolVersion
            return {
              dispatchId: input.dispatchId,
              state: 'ready',
              runtimeEpoch: 'legacy_runtime_epoch',
              worktreeId: 'repo::legacy-worktree',
              terminalHandle: 'term_legacy_worker',
              effects: [],
              residualResources: []
            }
          }
          if (method === 'orchestration.federationPull') {
            return { runtimeEpoch: 'legacy_runtime_epoch', items: legacyItems }
          }
          if (method === 'orchestration.federationAck') {
            acknowledgment = params as Record<string, unknown>
            return {
              acknowledgedThrough: (params as { throughSequence: number }).throughSequence
            }
          }
          throw new Error(`Unexpected legacy worker method ${method}`)
        }
      )
      const task = createHomeTask()

      await homeDispatcher.dispatch(startRequest(task.id))
      homeRuntime.stopOrchestrationFederationRelay()
      const dispatch = homeDb.getDispatchContext(task.id)!
      legacyItems = [
        {
          dispatch_id: dispatch.id,
          direction: 'to_home',
          sequence: 1,
          message_id: `msg_legacy_protocol_${protocolVersion}`,
          kind: 'worker_done',
          payload: JSON.stringify({
            from: 'term_legacy_worker',
            subject: 'Done',
            body: 'Completed on an older worker server',
            type: 'worker_done',
            priority: 'normal',
            threadId: null,
            payload: JSON.stringify({
              taskId: task.id,
              dispatchId: dispatch.id,
              outcome: 'succeeded'
            })
          })
        }
      ]

      await homeRuntime.syncOrchestrationFederatedDispatch(dispatch.id)

      expect({
        attachProtocol,
        task: homeDb.getTask(task.id)?.status,
        dispatch: homeDb.getDispatchContextById(dispatch.id)?.status,
        acknowledgment
      }).toEqual({
        attachProtocol: protocolVersion,
        task: 'completed',
        dispatch: 'completed',
        acknowledgment: { dispatchId: dispatch.id, throughSequence: 1 }
      })
    }
  )

  it.each([1, 2] as const)(
    'retries a lost protocol v%s completion acknowledgment after Run-home restart',
    async (protocolVersion) => {
      workerCapabilities = legacyWorkerCapabilities(protocolVersion)
      const task = createHomeTask()
      await homeDispatcher.dispatch(startRequest(task.id))
      homeRuntime.stopOrchestrationFederationRelay()
      const dispatch = homeDb.getDispatchContext(task.id)!
      await dispatchRemoteCompletion(
        task.id,
        dispatch.id,
        `protocol_${protocolVersion}_lost_ack_completion`
      )
      failNextAckBeforeDelivery = true

      await expect(homeRuntime.syncOrchestrationFederatedDispatch(dispatch.id)).rejects.toThrow(
        'connection lost before acknowledgment'
      )
      expect({
        task: homeDb.getTask(task.id)?.status,
        acknowledged: homeDb.getFederatedDispatch(dispatch.id)?.to_home_acknowledged_sequence,
        pending: workerDb.listPendingFederationRelay(dispatch.id, 'to_home').length
      }).toEqual({ task: 'completed', acknowledged: 0, pending: 1 })

      restartHomeRuntime()
      await vi.waitFor(() =>
        expect(workerDb.listPendingFederationRelay(dispatch.id, 'to_home')).toHaveLength(0)
      )

      expect({
        acknowledged: homeDb.getFederatedDispatch(dispatch.id)?.to_home_acknowledged_sequence,
        attachment: workerDb.getRemoteDispatchAttachment(dispatch.id)?.state,
        pending: workerDb.listPendingFederationRelay(dispatch.id, 'to_home').length,
        ackAttempts
      }).toEqual({ acknowledged: 1, attachment: 'succeeded', pending: 0, ackAttempts: 2 })
    }
  )

  it.each([1, 2] as const)(
    'completes a persisted protocol v%s worker after its worker server updates',
    async (protocolVersion) => {
      const dispatchId = `ctx_persisted_protocol_${protocolVersion}`
      const taskId = `task_persisted_protocol_${protocolVersion}`
      workerDb.createRemoteDispatchAttachment({
        dispatchId,
        taskId,
        homePeerFingerprint: 'run-home-device-token',
        protocolVersion,
        runtimeEpoch: workerRuntime.getRuntimeId(),
        mutationReceipt: {
          callerFingerprint: 'run-home-device-token',
          requestId: `persisted_protocol_${protocolVersion}_attach`,
          method: 'orchestration.federationAttachStart',
          payloadHash: `persisted_protocol_${protocolVersion}_payload`
        }
      })
      const capability = workerDb.prepareRemoteAttachmentAuthority({
        dispatchId,
        paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        processIncarnation: 'windows_runtime:pty:1',
        worktreeId: 'repo::persisted-worker',
        terminalHandle: 'term_windows_worker',
        setupState: 'completed',
        effects: []
      })
      workerDb.markRemoteAttachmentReady(dispatchId)
      restartWorkerRuntime()

      const completion = (await workerDispatcher.dispatch({
        id: `rpc_persisted_protocol_${protocolVersion}_completion`,
        authToken: 'worker-local-token',
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: `persisted_protocol_${protocolVersion}_completion_request`,
        orchestrationCapability: capability,
        method: 'orchestration.send',
        params: {
          from: 'term_windows_worker',
          subject: 'Done after update',
          type: 'worker_done',
          payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
        }
      })) as RuntimeRpcResponse<unknown>

      expect({
        completion: lifecycleResult(completion),
        attachment: workerDb.getRemoteDispatchAttachment(dispatchId)?.state,
        pending: workerDb.listPendingFederationRelay(dispatchId, 'to_home').length
      }).toEqual({ completion: 'completed', attachment: 'succeeded', pending: 1 })
    }
  )

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

  it('rejects conflicting terminal outcomes without acknowledging either report', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    homeRuntime.stopOrchestrationFederationRelay()
    const dispatch = homeDb.getDispatchContext(task.id)!
    const reports = (['succeeded', 'failed'] as const).map((outcome) =>
      workerDb.enqueueFederationRelay({
        dispatchId: dispatch.id,
        direction: 'to_home',
        kind: 'worker_done',
        payload: JSON.stringify({
          payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome })
        })
      })
    )

    await expect(
      workerDispatcher.dispatch({
        id: 'rpc_conflicting_settlements',
        authToken: 'run-home-device-token',
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: 'conflicting_settlements_request',
        method: 'orchestration.federationAck',
        params: {
          dispatchId: dispatch.id,
          throughSequence: reports[1].sequence,
          settlements: [
            {
              sequence: reports[0].sequence,
              lifecycle: { action: 'completed', authority: 'run_home' }
            },
            {
              sequence: reports[1].sequence,
              lifecycle: { action: 'failed', authority: 'run_home' }
            }
          ]
        }
      })
    ).resolves.toMatchObject({ ok: false, error: { code: 'request_mismatch' } })
    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)?.state).toBe('ready')
    expect(workerDb.listPendingFederationRelay(dispatch.id, 'to_home')).toHaveLength(2)
  })

  it('acknowledges preexisting same-outcome terminal reports atomically', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    homeRuntime.stopOrchestrationFederationRelay()
    const dispatch = homeDb.getDispatchContext(task.id)!
    const reports = ['first', 'retry'].map((body) =>
      workerDb.enqueueFederationRelay({
        dispatchId: dispatch.id,
        direction: 'to_home',
        kind: 'worker_done',
        payload: JSON.stringify({
          body,
          payload: JSON.stringify({
            taskId: task.id,
            dispatchId: dispatch.id,
            outcome: 'succeeded'
          })
        })
      })
    )

    await expect(
      workerDispatcher.dispatch({
        id: 'rpc_identical_settlements',
        authToken: 'run-home-device-token',
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: 'identical_settlements_request',
        method: 'orchestration.federationAck',
        params: {
          dispatchId: dispatch.id,
          throughSequence: reports[1].sequence,
          settlements: reports.flatMap((report) => {
            const settlement = {
              sequence: report.sequence,
              lifecycle: { action: 'completed' as const, authority: 'run_home' as const }
            }
            return [settlement, settlement]
          })
        }
      })
    ).resolves.toMatchObject({ ok: true, result: { acknowledgedThrough: reports[1].sequence } })
    expect(workerDb.getRemoteDispatchAttachment(dispatch.id)?.state).toBe('succeeded')
    expect(workerDb.listPendingFederationRelay(dispatch.id, 'to_home')).toHaveLength(0)
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

  it('keeps terminal settlement replayable until the worker durably acknowledges it', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    homeRuntime.stopOrchestrationFederationRelay()
    const dispatch = homeDb.getDispatchContext(task.id)!
    const controller = new AbortController()
    const sent = dispatchRemoteCompletion(
      task.id,
      dispatch.id,
      'replayed_worker_done_request',
      controller.signal
    )
    await vi.waitFor(() =>
      expect(workerDb.listPendingFederationRelay(dispatch.id, 'to_home')).toHaveLength(1)
    )
    failNextAckBeforeDelivery = true

    homeRuntime.ensureOrchestrationFederationRelay()
    await vi.waitFor(() => expect(ackAttempts).toBe(1))
    const acknowledgedAfterLoss = homeDb.getFederatedDispatch(
      dispatch.id
    )?.to_home_acknowledged_sequence
    restartHomeRuntime()
    await vi.waitFor(() =>
      expect(workerDb.getRemoteDispatchAttachment(dispatch.id)?.state).toBe('succeeded')
    )
    const acknowledgedAfterRetry = homeDb.getFederatedDispatch(
      dispatch.id
    )?.to_home_acknowledged_sequence
    restartHomeRuntime()
    homeRuntime.ensureOrchestrationFederationRelay()
    await homeRuntime.syncOrchestrationFederation()

    const observed = {
      homeTask: homeDb.getTask(task.id)?.status,
      workerAttachment: workerDb.getRemoteDispatchAttachment(dispatch.id)?.state,
      pendingWorkerRelay: workerDb.listPendingFederationRelay(dispatch.id, 'to_home').length,
      acknowledgedAfterLoss,
      acknowledgedAfterRetry,
      ackAttempts
    }
    controller.abort()
    const response = (await sent) as RuntimeRpcResponse<unknown>

    expect({ ...observed, completion: lifecycleResult(response) }).toEqual({
      homeTask: 'completed',
      workerAttachment: 'succeeded',
      pendingWorkerRelay: 0,
      acknowledgedAfterLoss: 0,
      acknowledgedAfterRetry: 1,
      ackAttempts: 2,
      completion: 'completed'
    })
  })

  it('acknowledges duplicate identical terminal reports idempotently', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    homeRuntime.stopOrchestrationFederationRelay()
    const dispatch = homeDb.getDispatchContext(task.id)!
    const controllers = [new AbortController(), new AbortController()]
    const enqueue = vi.spyOn(workerDb, 'enqueueFederationRelay')
    const sent = controllers.map((controller, index) =>
      dispatchRemoteCompletion(
        task.id,
        dispatch.id,
        `duplicate_worker_done_${index + 1}`,
        controller.signal
      )
    )
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2))
    await homeRuntime.syncOrchestrationFederation()

    const observed = {
      homeTask: homeDb.getTask(task.id)?.status,
      workerAttachment: workerDb.getRemoteDispatchAttachment(dispatch.id)?.state,
      pendingWorkerRelay: workerDb.listPendingFederationRelay(dispatch.id, 'to_home').length,
      ackAttempts
    }
    for (const controller of controllers) {
      controller.abort()
    }
    const responses = (await Promise.all(sent)) as RuntimeRpcResponse<unknown>[]

    expect({ ...observed, completions: responses.map(lifecycleResult) }).toEqual({
      homeTask: 'completed',
      workerAttachment: 'succeeded',
      pendingWorkerRelay: 0,
      ackAttempts: 1,
      completions: ['completed', 'completed']
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
