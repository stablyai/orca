import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/environment-transport'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { authenticatedCallerFingerprint } from '../orchestration-mutation-executor'
import { ORCHESTRATION_METHODS } from './orchestration'

describe('orchestration federation control mail', () => {
  const homeToken = 'run-home-device-token'
  const workerToken = 'worker-local-token'
  const workerPeerFingerprint = 'worker-peer'
  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const processIncarnation = 'worker-runtime:pty:1'
  let homeDb: OrchestrationDb
  let workerDb: OrchestrationDb
  let homeRuntime: OrcaRuntimeService
  let workerRuntime: OrcaRuntimeService
  let homeDispatcher: RpcDispatcher
  let workerDispatcher: RpcDispatcher
  let dispatchId: string
  let runId: string

  beforeEach(() => {
    workerDb = new OrchestrationDb(':memory:')
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    vi.spyOn(workerRuntime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_worker' ? workerPaneKey : null
    )
    vi.spyOn(workerRuntime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? processIncarnation : null
    )
    workerDispatcher = new RpcDispatcher({
      runtime: workerRuntime,
      methods: ORCHESTRATION_METHODS
    })

    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => ({
        environmentId: 'environment_worker',
        name: 'worker',
        peerFingerprint: workerPeerFingerprint
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
          authToken: homeToken,
          method,
          params,
          orchestrationContractVersion: envelope?.orchestrationContractVersion,
          orchestrationRequestId: envelope?.orchestrationRequestId
        })) as RuntimeRpcResponse<unknown>
        return response
      }
    }
    homeDb = new OrchestrationDb(':memory:')
    homeRuntime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    homeRuntime.setOrchestrationDb(homeDb)
    vi.spyOn(homeRuntime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : null
    )
    homeDispatcher = new RpcDispatcher({
      runtime: homeRuntime,
      methods: ORCHESTRATION_METHODS
    })

    const run = homeDb.createRun({
      objective: 'Federated control mail',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    })
    runId = run.id
    const task = homeDb.createTask({ spec: 'Wait for coordinator guidance', runId })
    const started = homeDb.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      federation: {
        environmentId: 'environment_worker',
        environmentName: 'worker',
        peerFingerprint: workerPeerFingerprint,
        protocolVersion: 2
      }
    })
    dispatchId = started.dispatch.id
    homeDb.markWorkerDispatchReady(dispatchId)

    const homeFingerprint = authenticatedCallerFingerprint({
      id: 'home',
      authToken: homeToken,
      method: 'orchestration.federationImport'
    })
    workerDb.createRemoteDispatchAttachment({
      dispatchId,
      taskId: task.id,
      homePeerFingerprint: homeFingerprint,
      protocolVersion: 2,
      runtimeEpoch: workerRuntime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: homeFingerprint,
        requestId: 'attach-worker',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'attach-worker-payload'
      }
    })
    workerDb.prepareRemoteAttachmentAuthority({
      dispatchId,
      paneKey: workerPaneKey,
      processIncarnation,
      worktreeId: 'repo::worker',
      terminalHandle: 'term_worker',
      setupState: 'not_applicable',
      effects: []
    })
    workerDb.markRemoteAttachmentReady(dispatchId)
  })

  afterEach(() => {
    homeRuntime.stopOrchestrationFederationRelay()
    homeDb.close()
    workerDb.close()
  })

  it('routes an exact Dispatch message through the durable relay', async () => {
    vi.spyOn(homeRuntime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
    const sent = await homeDispatcher.dispatch({
      id: 'send-control',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'send-control-request',
      method: 'orchestration.send',
      params: {
        from: 'term_coord',
        to: `dispatch:${dispatchId}`,
        subject: 'Continue',
        body: 'Run the focused follow-up.',
        type: 'status'
      }
    })

    expect(sent).toMatchObject({
      ok: true,
      result: { relay: { dispatchId, accepted: true } }
    })
    expect(homeDb.listPendingFederationRelay(dispatchId, 'to_worker')).toHaveLength(1)

    await homeRuntime.syncOrchestrationFederation()
    const checked = await workerDispatcher.dispatch(checkRequest('check-imported'))

    expect(checked).toMatchObject({
      ok: true,
      result: {
        dispatchId,
        count: 1,
        messages: [
          {
            to_handle: `dispatch:${dispatchId}`,
            subject: 'Continue',
            body: 'Run the focused follow-up.'
          }
        ]
      }
    })
    expect(homeDb.listPendingFederationRelay(dispatchId, 'to_worker')).toHaveLength(0)
  })

  it('wakes a remote worker waiter when control mail imports', async () => {
    const waiting = workerDispatcher.dispatch(checkRequest('wait-for-control', true))
    await Promise.resolve()

    const imported = await workerDispatcher.dispatch(
      importRequest('import-control', 1, 'relay-control')
    )

    expect(imported).toMatchObject({
      ok: true,
      result: { acknowledgedThrough: 1, imported: 1 }
    })
    await expect(waiting).resolves.toMatchObject({
      ok: true,
      result: {
        dispatchId,
        count: 1,
        messages: [{ id: 'relay-control', subject: 'Continue' }]
      }
    })
  })

  it('accepts a repeated import after a lost acknowledgment without duplicating mail', async () => {
    const first = await workerDispatcher.dispatch(importRequest('first-import', 1, 'relay-control'))
    const repeated = await workerDispatcher.dispatch(
      importRequest('repeated-import', 1, 'different-message-id')
    )

    expect(first).toMatchObject({ ok: true, result: { imported: 1 } })
    expect(repeated).toMatchObject({ ok: true, result: { imported: 0 } })
    expect(workerDb.getUnreadMessages(`dispatch:${dispatchId}`)).toHaveLength(1)
  })

  it('does not deliver pending control mail after worker completion', async () => {
    vi.spyOn(homeRuntime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
    await homeDispatcher.dispatch({
      id: 'send-stale-control',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'send-stale-control-request',
      method: 'orchestration.send',
      params: {
        from: 'term_coord',
        to: `dispatch:${dispatchId}`,
        subject: 'Stale follow-up',
        body: 'This must not arrive after completion.',
        type: 'status'
      }
    })
    const waiting = workerDispatcher.dispatch(checkRequest('wait-before-completion', true, 30))
    await Promise.resolve()

    const taskId = homeDb.getDispatchContextById(dispatchId)!.task_id
    workerDb.enqueueFederationRelay({
      dispatchId,
      direction: 'to_home',
      kind: 'worker_done',
      payload: JSON.stringify({
        from: `dispatch:${dispatchId}`,
        subject: 'Done',
        body: 'Completed before the follow-up arrived.',
        type: 'worker_done',
        priority: 'normal',
        threadId: null,
        payload: JSON.stringify({
          taskId,
          dispatchId,
          outcome: 'succeeded',
          filesModified: []
        })
      }),
      settleRemoteOutcome: 'succeeded'
    })

    await homeRuntime.syncOrchestrationFederation()

    expect(homeDb.getWorkerDispatch(dispatchId)?.state).toBe('succeeded')
    expect(workerDb.getUnreadMessages(`dispatch:${dispatchId}`)).toHaveLength(0)
    expect(homeDb.listPendingFederationRelay(dispatchId, 'to_worker')).toHaveLength(1)
    await expect(
      workerDispatcher.dispatch(importRequest('late-direct-import', 1, 'late-control'))
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'dispatch_inactive' }
    })
    await expect(waiting).resolves.toMatchObject({
      ok: true,
      result: { count: 0, timedOut: true }
    })
  })

  it('wakes only waiters whose filter matches an imported control message', async () => {
    const escalationWaiter = workerDispatcher.dispatch(
      checkRequest('wait-escalation', true, 1_000, 'escalation')
    )
    const statusWaiter = workerDispatcher.dispatch(checkRequest('wait-status', true, 30, 'status'))
    await Promise.resolve()

    await workerDispatcher.dispatch(
      importRequest('import-escalation', 1, 'relay-escalation', 'escalation')
    )

    await expect(escalationWaiter).resolves.toMatchObject({
      ok: true,
      result: {
        count: 1,
        messages: [{ id: 'relay-escalation', type: 'escalation' }]
      }
    })
    await expect(statusWaiter).resolves.toMatchObject({
      ok: true,
      result: { count: 0, timedOut: true }
    })
  })

  function checkRequest(id: string, wait = false, timeoutMs = 5_000, types?: string): RpcRequest {
    return {
      id,
      authToken: workerToken,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      method: 'orchestration.check',
      params: {
        terminal: 'term_worker',
        wait,
        timeoutMs,
        types
      }
    }
  }

  function importRequest(
    id: string,
    sequence: number,
    messageId: string,
    type = 'status'
  ): RpcRequest {
    return {
      id,
      authToken: homeToken,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      method: 'orchestration.federationImport',
      params: {
        dispatchId,
        items: [
          {
            dispatch_id: dispatchId,
            direction: 'to_worker',
            sequence,
            message_id: messageId,
            kind: 'control_message',
            payload: JSON.stringify({
              from: `run:${runId}`,
              subject: 'Continue',
              body: 'Run the focused follow-up.',
              type,
              priority: 'normal',
              threadId: null,
              payload: null
            })
          }
        ]
      }
    }
  }
})
