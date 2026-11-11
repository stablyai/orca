import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeRpcResponse } from '../../../../../../shared/runtime-rpc-envelope'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import '../../../../orchestration/db/contract-constants'
import '../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../orchestration/db/dispatch-row-writer'
import '../../../../orchestration/db/attempt-outcome-projection'
import type { OrchestrationEnvironmentTransport } from '../../../../orchestration/federation/environment-transport'
import type { RpcRequest } from '../../../core'
import { RpcDispatcher } from '../../../dispatcher'
import { fingerprintAuthenticatedPairingCredential } from '../../../server/pairing/device-principal'
import { ORCHESTRATION_METHODS } from '../orchestration'
import { syncFederationBarrier } from './federation-sync-barrier.test-support'

describe('orchestration federation control mail', () => {
  const homeToken = 'run-home-device-token'
  const homeFingerprint = fingerprintAuthenticatedPairingCredential(homeToken)
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
        const response = (await workerDispatcher.dispatch(
          {
            id: `remote_${method}`,
            authToken: homeToken,
            method,
            params,
            orchestrationContractVersion: envelope?.orchestrationContractVersion,
            orchestrationRequestId: envelope?.orchestrationRequestId
          },
          { authenticatedCallerFingerprint: homeFingerprint }
        )) as RuntimeRpcResponse<unknown>
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
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
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

    workerDb.createRemoteDispatchAttachment({
      runId: 'run-home',
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
    vi.useRealTimers()
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

    await syncFederationBarrier(homeRuntime, homeDb)
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

    const imported = await dispatchImport(importRequest('import-control', 1, 'relay-control'))

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
    const first = await dispatchImport(importRequest('first-import', 1, 'relay-control'))
    const repeated = await dispatchImport(
      importRequest('repeated-import', 1, 'different-message-id')
    )

    expect(first).toMatchObject({ ok: true, result: { imported: 1 } })
    expect(repeated).toMatchObject({ ok: true, result: { imported: 0 } })
    expect(workerDb.getUnreadMessages(`dispatch:${dispatchId}`)).toHaveLength(1)
  })

  it('refuses a reply to a finished paired-host report by naming a new worker there', async () => {
    const taskId = homeDb.getDispatchContextById(dispatchId)!.task_id
    workerDb.enqueueFederationRelay({
      dispatchId,
      direction: 'to_home',
      kind: 'worker_done',
      payload: JSON.stringify({
        from: `dispatch:${dispatchId}`,
        subject: 'Done',
        body: 'Finished remotely.',
        type: 'worker_done',
        priority: 'normal',
        threadId: null,
        payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded', filesModified: [] })
      }),
      settleRemoteOutcome: 'succeeded'
    })
    await syncFederationBarrier(homeRuntime, homeDb)
    const report = homeDb
      .getUnreadMessages(`run:${runId}`)
      .find((message) => message.type === 'worker_done')!

    await expect(
      homeDispatcher.dispatch({
        id: 'reply-finished-remote',
        authToken: 'coordinator-token',
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: 'reply-finished-remote-request',
        method: 'orchestration.reply',
        params: { from: 'term_coord', id: report.id, body: 'One more thing' }
      })
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'dispatch_inactive',
        data: { followUp: { kind: 'worker_start_on', server: 'worker' } }
      }
    })
    expect(homeDb.getAllMessagesForHandle(`dispatch:${dispatchId}`)).toHaveLength(0)
    expect(homeDb.listPendingFederationRelay(dispatchId, 'to_worker')).toHaveLength(0)
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

  function dispatchImport(request: RpcRequest) {
    return workerDispatcher.dispatch(request, {
      authenticatedCallerFingerprint: homeFingerprint
    })
  }
})
