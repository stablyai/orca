import { registerFederationAnswerAtomicityTest } from './federation-answer-atomicity.test-support'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import '../../../../orchestration/db/contract-constants'
import '../../../../orchestration/db/messages/mailbox-routing-page'
import '../../../../orchestration/db/dispatch-row-writer'
import '../../../../orchestration/db/attempt-outcome-projection'
import type { OrchestrationEnvironmentTransport } from '../../../../orchestration/federation/environment-transport'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../orchestration'
import { createFederationWorkerStartRequest as startRequest } from './federation-request.test-support'
import { configureFederationWorkerRuntime } from './federation-runtime.test-support'
import { syncFederationBarrier } from './federation-sync-barrier.test-support'

describe('orchestration federation', () => {
  const databases: OrchestrationDb[] = []
  let homeDb: OrchestrationDb
  let workerDb: OrchestrationDb
  let homeRuntime: OrcaRuntimeService
  let workerRuntime: OrcaRuntimeService
  let homeDispatcher: RpcDispatcher
  let workerDispatcher: RpcDispatcher
  let workerCapabilities: string[]
  let workerPeerFingerprint: string
  let loseNextAckResponse: boolean

  beforeEach(() => {
    homeDb = new OrchestrationDb(':memory:')
    workerDb = new OrchestrationDb(':memory:')
    databases.push(homeDb, workerDb)
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    workerDispatcher = new RpcDispatcher({
      runtime: workerRuntime,
      methods: ORCHESTRATION_METHODS
    })
    workerCapabilities = [...(workerRuntime.getStatus().capabilities ?? [])]
    workerPeerFingerprint = 'windows_peer_fingerprint'
    loseNextAckResponse = false
    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => ({
        environmentId: 'environment_windows',
        name: 'windows',
        peerFingerprint: workerPeerFingerprint,
        pairingRevision: 73
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
        const response = await workerDispatcher.dispatch({
          id: `remote_${method}`,
          authToken: 'run-home-device-token',
          method,
          params,
          orchestrationContractVersion: envelope?.orchestrationContractVersion,
          orchestrationRequestId: envelope?.orchestrationRequestId
        })
        if (method === 'orchestration.federationAck' && loseNextAckResponse) {
          loseNextAckResponse = false
          throw new Error('connection lost after acknowledgment')
        }
        return response
      }
    }
    homeRuntime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    homeRuntime.setOrchestrationDb(homeDb)
    homeDispatcher = new RpcDispatcher({
      runtime: homeRuntime,
      methods: ORCHESTRATION_METHODS
    })
    vi.spyOn(homeRuntime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : null
    )
    configureFederationWorkerRuntime(workerRuntime)
  })

  afterEach(() => {
    homeRuntime.stopOrchestrationFederationRelay()
    for (const db of databases.splice(0)) {
      db.close()
    }
  })

  function createHomeTask() {
    const run = homeDb.createRun({
      objective: 'Mac to Windows',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    return homeDb.createTask({ spec: 'Audit Windows behavior', runId: run.id })
  }

  function restartWorkerRuntime(): void {
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    configureFederationWorkerRuntime(workerRuntime)
    workerDispatcher = new RpcDispatcher({
      runtime: workerRuntime,
      methods: ORCHESTRATION_METHODS
    })
    workerCapabilities = [...(workerRuntime.getStatus().capabilities ?? [])]
  }

  it('fails before remote task input when wait-for-setup fails', async () => {
    vi.mocked(workerRuntime.createManagedWorktree).mockResolvedValueOnce({
      worktree: { id: 'repo::windows-worktree', repoId: 'repo' },
      startupTerminal: { spawned: true, handle: 'term_windows_worker' },
      setupReceipt: {
        requested: 'run',
        hookFound: true,
        startupPolicy: 'wait-for-setup',
        state: 'running'
      }
    } as never)
    vi.mocked(workerRuntime.waitForTerminal).mockResolvedValueOnce({
      handle: 'term_windows_worker',
      condition: 'tui-idle',
      satisfied: false,
      status: 'exited',
      exitCode: 1
    })
    const task = createHomeTask()

    const response = await homeDispatcher.dispatch(startRequest(task.id))

    expect(response).toMatchObject({
      ok: true,
      result: {
        state: 'failed',
        failedStage: 'setup_wait',
        setup: { state: 'failed' },
        effects: expect.arrayContaining([
          expect.objectContaining({ kind: 'setup', state: 'failed' })
        ])
      }
    })
    expect(homeDb.getTask(task.id)?.status).toBe('failed')
    expect(workerRuntime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('durably relays remote completion into the home Run and acknowledges it', async () => {
    const task = createHomeTask()
    const started = await homeDispatcher.dispatch(startRequest(task.id))
    expect(started.ok).toBe(true)
    const dispatch = homeDb.getDispatchContext(task.id)!

    const sent = await workerDispatcher.dispatch({
      id: 'rpc_worker_done',
      authToken: 'worker-local-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'worker_done_request',
      method: 'orchestration.send',
      params: {
        from: 'term_windows_worker',
        subject: 'Windows audit complete',
        body: 'Audited Windows behavior. Found no blocker. Nothing remains.',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          outcome: 'succeeded',
          filesModified: []
        })
      }
    })
    expect(sent).toMatchObject({ ok: true, result: { lifecycle: { action: 'completed' } } })
    expect(homeDb.getTask(task.id)?.status).toBe('completed')

    await syncFederationBarrier(homeRuntime, homeDb)

    expect(homeDb.getTask(task.id)?.status).toBe('completed')
    expect(homeDb.getWorkerDispatch(dispatch.id)?.state).toBe('succeeded')
    expect(homeDb.getRunMailboxHistory(task.run_id, 10)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^relay_/),
          type: 'worker_done',
          subject: 'Windows audit complete'
        })
      ])
    )
    expect(
      workerDb.listFederationRelay({
        dispatchId: dispatch.id,
        direction: 'to_home',
        afterSequence: 0
      })[0]
    ).toMatchObject({ acked_at: expect.any(String) })
  })

  registerFederationAnswerAtomicityTest(() => ({
    homeDb,
    workerDb,
    homeRuntime,
    homeDispatcher,
    createHomeTask
  }))

  it('rejects a reordered relay gap, then converges without loss or duplication', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = homeDb.getDispatchContext(task.id)!

    expect(() =>
      homeDb.importFederatedRelayItem({
        dispatchId: dispatch.id,
        sequence: 2,
        message: {
          id: 'relay_gap',
          runId: task.run_id,
          from: `dispatch:${dispatch.id}`,
          to: `run:${task.run_id}`,
          subject: 'Gap',
          body: 'Out of order',
          type: 'status',
          priority: 'normal'
        },
        lifecycle: { kind: 'none' }
      })
    ).toThrow(/not contiguous/)
    expect(homeDb.getMessageById('relay_gap')).toBeUndefined()
    expect(homeDb.getFederatedDispatch(dispatch.id)?.to_home_imported_sequence).toBe(0)

    homeDb.importFederatedRelayItem({
      dispatchId: dispatch.id,
      sequence: 1,
      message: {
        id: 'relay_first',
        runId: task.run_id,
        from: `dispatch:${dispatch.id}`,
        to: `run:${task.run_id}`,
        subject: 'First',
        body: 'Arrived after the gap was rejected',
        type: 'status',
        priority: 'normal'
      },
      lifecycle: { kind: 'none' }
    })
    const recovered = homeDb.importFederatedRelayItem({
      dispatchId: dispatch.id,
      sequence: 2,
      message: {
        id: 'relay_gap',
        runId: task.run_id,
        from: `dispatch:${dispatch.id}`,
        to: `run:${task.run_id}`,
        subject: 'Gap',
        body: 'Out of order',
        type: 'status',
        priority: 'normal'
      },
      lifecycle: { kind: 'none' }
    })
    const duplicate = homeDb.importFederatedRelayItem({
      dispatchId: dispatch.id,
      sequence: 2,
      message: {
        id: 'relay_gap',
        runId: task.run_id,
        from: `dispatch:${dispatch.id}`,
        to: `run:${task.run_id}`,
        subject: 'Gap',
        body: 'Out of order',
        type: 'status',
        priority: 'normal'
      },
      lifecycle: { kind: 'none' }
    })

    expect(recovered.duplicate).toBe(false)
    expect(duplicate.duplicate).toBe(true)
    expect(homeDb.getFederatedDispatch(dispatch.id)?.to_home_imported_sequence).toBe(2)
    expect(
      homeDb
        .getRunMailboxHistory(task.run_id, 10)
        .filter((message) => ['relay_first', 'relay_gap'].includes(message.id))
    ).toHaveLength(2)
  })

  it('treats a worker runtime ID change as an epoch, not a new server', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    await syncFederationBarrier(homeRuntime, homeDb)
    vi.spyOn(homeRuntime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
    const dispatch = homeDb.getDispatchContext(task.id)!
    const oldEpoch = homeDb.getFederatedDispatch(dispatch.id)?.remote_runtime_epoch
    homeRuntime.stopOrchestrationFederationRelay()
    restartWorkerRuntime()

    const shown = await homeDispatcher.dispatch({
      id: 'rpc_worker_restart_show',
      authToken: 'coordinator-token',
      method: 'orchestration.workerShow',
      params: { dispatch: dispatch.id }
    })
    expect(shown).toMatchObject({
      ok: true,
      result: {
        observation: { status: 'live', exactWorker: true },
        // Host evidence must drive projection; local-only push snapshots previously contradicted the adjacent remote observation.
        projection: {
          host: { kind: 'remote', id: 'environment_windows' },
          liveness: { verdict: 'live', source: 'execution_host' },
          nextAction: { kind: 'none', argv: [] }
        }
      }
    })
    expect(homeDb.getFederatedDispatch(dispatch.id)?.remote_runtime_epoch).not.toBe(oldEpoch)
    expect(homeDb.getFederatedDispatch(dispatch.id)?.peer_fingerprint).toBe(
      'windows_peer_fingerprint'
    )
  })

  it('rejects a re-paired server before show or stop effects', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = homeDb.getDispatchContext(task.id)!
    workerPeerFingerprint = 'replacement_windows_peer'

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

  it('returns stop_unknown when the worker server disconnects after the home fence', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = homeDb.getDispatchContext(task.id)!
    vi.spyOn(homeRuntime, 'callOrchestrationWorkerServer').mockImplementation(
      async (_selector, method) => {
        if (method === 'status.get') {
          return { runtimeId: workerRuntime.getRuntimeId(), capabilities: workerCapabilities }
        }
        if (method === 'orchestration.federationShow') {
          return {}
        }
        if (method === 'orchestration.federationStop') {
          throw new Error('connection lost')
        }
        throw new Error(`Unexpected relay method ${method}`)
      }
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

  it('never reads or closes a same-looking replacement process', async () => {
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
