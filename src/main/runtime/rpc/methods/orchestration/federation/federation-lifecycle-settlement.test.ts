import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY
} from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeRpcResponse } from '../../../../../../shared/runtime-rpc-envelope'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import '../../../../orchestration/db/contract-constants'
import '../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../orchestration/db/dispatch-row-writer'
import '../../../../orchestration/db/attempt-outcome-projection'
import type { OrchestrationEnvironmentTransport } from '../../../../orchestration/federation/environment-transport'
import '../../../../orchestration/legacy-remote/federation-lifecycle-settlement'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../orchestration'
import { createFederationWorkerStartRequest as startRequest } from './federation-request.test-support'

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
        return await workerDispatcher.dispatch({
          id: `remote_${method}`,
          authToken: 'run-home-device-token',
          method,
          params,
          orchestrationContractVersion: envelope?.orchestrationContractVersion,
          orchestrationRequestId: envelope?.orchestrationRequestId
        })
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
    vi.spyOn(workerRuntime, 'validateOrchestrationAgentLauncherForRepo').mockResolvedValue()
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
    const sent = workerDispatcher.dispatch({
      id: 'rpc_waiting_worker_done',
      authToken: 'worker-local-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'waiting_worker_done_request',
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
    'completes a persisted protocol v%s worker after its worker server updates',
    async (protocolVersion) => {
      const dispatchId = `ctx_persisted_protocol_${protocolVersion}`
      const taskId = `task_persisted_protocol_${protocolVersion}`
      workerDb.createRemoteDispatchAttachment({
        runId: 'run-home',
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
      workerDb.prepareRemoteAttachmentAuthority({
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
    const controller = new AbortController()
    const sent = workerDispatcher.dispatch(
      {
        id: 'rpc_aborted_worker_done',
        authToken: 'worker-local-token',
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: 'aborted_worker_done_request',
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
