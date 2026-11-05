import '../../../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_FEDERATION_FINISHED_WORKER_MAIL_PROTOCOL_VERSION,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION
} from '../../../../../../shared/protocol-version'
import type { RuntimeRpcResponse } from '../../../../../../shared/runtime-rpc-envelope'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import type { OrchestrationEnvironmentTransport } from '../../../../orchestration/environment-transport'
import { pullFinishedWorkerMail } from '../../../../orchestration/finished-worker-relay'
import { FINISHED_WORKER_HEARD_SECONDS } from '../../../../orchestration/db/federation/federation-relay-ack'
import { RpcDispatcher } from '../../../dispatcher'
import { fingerprintAuthenticatedPairingCredential } from '../../../../device-principal'
import { ORCHESTRATION_METHODS } from '../../orchestration'

describe('a finished worker on a paired host', () => {
  const homeToken = 'run-home-device-token'
  const homeFingerprint = fingerprintAuthenticatedPairingCredential(homeToken)
  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  let homeDb: OrchestrationDb
  let workerDb: OrchestrationDb
  let homeRuntime: OrcaRuntimeService
  let homeDispatcher: RpcDispatcher
  let workerDispatcher: RpcDispatcher
  let dispatchId: string
  let taskId: string
  let runId: string

  function setup(protocolVersion: number): void {
    workerDb = new OrchestrationDb(':memory:')
    const workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    vi.spyOn(workerRuntime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_worker' ? workerPaneKey : null
    )
    vi.spyOn(workerRuntime, 'getTerminalProcessIncarnation').mockReturnValue('worker:pty:1')
    workerDispatcher = new RpcDispatcher({ runtime: workerRuntime, methods: ORCHESTRATION_METHODS })
    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => ({ environmentId: 'env_worker', name: 'worker', peerFingerprint: 'worker' }),
      call: async (_selector, method, params, _timeoutMs, envelope) =>
        method === 'status.get'
          ? {
              id: 'status',
              ok: true,
              result: workerRuntime.getStatus(),
              _meta: { runtimeId: workerRuntime.getRuntimeId() }
            }
          : // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a unary orchestration dispatch answers with a runtime RPC response.
            ((await workerDispatcher.dispatch(
              {
                id: `remote_${method}`,
                authToken: homeToken,
                method,
                params,
                orchestrationContractVersion: envelope?.orchestrationContractVersion,
                orchestrationRequestId: envelope?.orchestrationRequestId
              },
              { authenticatedCallerFingerprint: homeFingerprint }
            )) as RuntimeRpcResponse<unknown>)
    }
    homeDb = new OrchestrationDb(':memory:')
    homeRuntime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    homeRuntime.setOrchestrationDb(homeDb)
    vi.spyOn(homeRuntime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : null
    )
    vi.spyOn(homeRuntime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
    homeDispatcher = new RpcDispatcher({ runtime: homeRuntime, methods: ORCHESTRATION_METHODS })

    runId = homeDb.createRun({
      objective: 'Finished remote worker',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    }).id
    taskId = homeDb.createTask({ spec: 'Count the files', runId }).id
    dispatchId = homeDb.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId,
      startOptions: {},
      federation: {
        environmentId: 'env_worker',
        environmentName: 'worker',
        peerFingerprint: 'worker',
        protocolVersion
      }
    }).dispatch.id
    homeDb.markWorkerDispatchReady(dispatchId)
    homeDb.updateFederatedDispatchResources({
      dispatchId,
      remoteRuntimeEpoch: workerRuntime.getRuntimeId(),
      worktreeId: 'repo::worker',
      terminalHandle: 'term_worker'
    })
    workerDb.createRemoteDispatchAttachment({
      runId: 'run-home',
      dispatchId,
      taskId,
      homePeerFingerprint: homeFingerprint,
      protocolVersion,
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
      processIncarnation: 'worker:pty:1',
      worktreeId: 'repo::worker',
      terminalHandle: 'term_worker',
      setupState: 'not_applicable',
      effects: []
    })
    workerDb.markRemoteAttachmentReady(dispatchId)
  }

  afterEach(() => {
    homeRuntime.stopOrchestrationFederationRelay()
    homeDb.close()
    workerDb.close()
  })

  const workerCall = (method: string, params: Record<string, unknown>) =>
    workerDispatcher.dispatch({
      id: `${method}_${Math.random()}`,
      authToken: 'worker-local-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      method,
      params: { from: 'term_worker', ...params }
    })
  const report = (outcome: string) => JSON.stringify({ taskId, dispatchId, outcome })
  // The home's per-host round for finished workers, as its timer runs it.
  const homePull = () =>
    pullFinishedWorkerMail(homeDb, 'env_worker', {
      ask: (environmentId) =>
        homeRuntime.callOrchestrationWorkerServer(
          environmentId,
          'orchestration.federationFinishedMail',
          {},
          5_000
        ),
      sync: (id) => homeRuntime.syncOrchestrationFederatedDispatchAfterCurrent(id),
      isCurrent: () => true
    })

  async function finish(): Promise<void> {
    const done = workerCall('orchestration.send', {
      type: 'worker_done',
      subject: 'Done',
      payload: report('succeeded')
    })
    await vi.waitFor(() =>
      expect(workerDb.listPendingFederationRelay(dispatchId, 'to_home')).toHaveLength(1)
    )
    await homeRuntime.syncOrchestrationFederatedDispatchAfterCurrent(dispatchId)
    await expect(done).resolves.toMatchObject({ ok: true })
    expect(homeDb.getWorkerDispatch(dispatchId)?.state).toBe('succeeded')
  }

  beforeEach(() => vi.clearAllMocks())

  it('still reaches its coordinator, and an ask gets its answer', async () => {
    setup(ORCHESTRATION_FEDERATION_FINISHED_WORKER_MAIL_PROTOCOL_VERSION)
    await finish()
    const settled = homeDb.getTask(taskId)

    await workerCall('orchestration.send', { subject: 'One more thing' })
    const again = await workerCall('orchestration.send', {
      type: 'worker_done',
      subject: 'Second report',
      payload: report('failed')
    })
    expect(again).toMatchObject({
      ok: true,
      result: { lifecycle: { action: 'completed', authority: 'run_home' } }
    })
    expect(await homePull()).toBe('listening')
    expect(
      homeDb.getUnreadMessages(`run:${runId}`).map((message) => [message.type, message.subject])
    ).toEqual([
      ['worker_done', 'Done'],
      ['status', 'One more thing'],
      ['status', 'Second report']
    ])
    expect(homeDb.getTask(taskId)).toEqual(settled)

    // Coordinator mail the worker never took before finishing must not hold its answer back.
    homeDb.enqueueFederationRelay({
      dispatchId,
      direction: 'to_worker',
      kind: 'control_message',
      payload: JSON.stringify({ from: 'term_coord', subject: 'Late', body: 'too late' })
    })
    const asking = workerCall('orchestration.ask', {
      question: 'Anything else?',
      wait: false,
      timeoutMs: 10_000
    })
    await vi.waitFor(() =>
      expect(workerDb.listPendingFederationRelay(dispatchId, 'to_home')).toHaveLength(1)
    )
    await homePull()
    const question = homeDb.getUnreadMessages(`run:${runId}`).at(-1)
    expect(question?.type).toBe('question')
    await homeDispatcher.dispatch({
      id: 'reply',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'reply-request',
      method: 'orchestration.reply',
      params: { from: 'term_coord', id: question?.id, body: 'Nothing else.' }
    })
    await homePull()
    await expect(asking).resolves.toMatchObject({
      ok: true,
      result: { answer: 'Nothing else.', timedOut: false }
    })
  })

  it('says why when its Run home predates mail from finished workers', async () => {
    setup(ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION)
    await finish()

    await expect(workerCall('orchestration.send', { subject: 'Later' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'run_home_unreachable' }
    })
    expect(await homePull()).toBe('done')
  })

  it('stops the home listening once the worker stops writing', async () => {
    setup(ORCHESTRATION_FEDERATION_FINISHED_WORKER_MAIL_PROTOCOL_VERSION)
    await finish()
    expect(await homePull()).toBe('listening')

    ageWorkerMail(FINISHED_WORKER_HEARD_SECONDS)
    await expect(
      workerCall('orchestration.send', { subject: 'Hours later' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'run_home_unreachable' }
    })
    expect(await homePull()).toBe('listening')
    ageWorkerMail(30)
    expect(await homePull()).toBe('done')
  })

  // Moves the worker's mail back in time on its host's clock, as if it had stopped writing that long ago.
  function ageWorkerMail(seconds: number): void {
    workerDb.db
      .prepare(
        `UPDATE federation_relay_items SET created_at = datetime(created_at, ?) WHERE direction = 'to_home'`
      )
      .run(`-${seconds} seconds`)
  }
})
