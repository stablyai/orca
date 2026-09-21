import { describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_STRUCTURED_READ_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { FederatedDispatchRow } from '../../../../orchestration/types'
import { readFederatedWorkerOutput } from './federated-worker-read'
import { parseRemoteReleaseReceipt, releaseFederatedWorker } from './federated-worker-release'
import { callFederatedWorkerShow } from '../worker/worker-observation'
import { syncFederatedDispatch } from '../../../../orchestration/federation-sync'
import { ORCHESTRATION_WORKER_STOP_METHODS } from '../worker/worker-stop'

const server = {
  environmentId: 'environment-worker',
  name: 'worker',
  peerFingerprint: 'peer-worker',
  pairingRevision: 73
}

describe('federated transport safety', () => {
  it('uses the same pairing-revision fence for mutation preflight and effect calls', async () => {
    const call = vi.fn(async (_selector, method: string) => ({
      id: method,
      ok: true as const,
      result:
        method === 'status.get'
          ? runtimeStatus([ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY])
          : {
              dispatchId: 'dispatch-worker',
              state: 'released',
              processAction: 'closed_agent_terminal',
              archive: null
            },
      _meta: { runtimeId: 'epoch-worker' }
    }))
    const runtime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: {
        resolve: () => server,
        call
      }
    })

    await runtime.callOrchestrationWorkerServer(
      server.environmentId,
      'orchestration.federationRelease',
      { dispatchId: 'dispatch-worker' },
      30_000,
      { orchestrationRequestId: 'release-request' },
      { expectedEnvironmentPairingRevision: server.pairingRevision }
    )

    expect(call.mock.calls.map((entry) => entry[1])).toEqual([
      'status.get',
      'orchestration.federationRelease'
    ])
    for (const entry of call.mock.calls) {
      expect((entry as unknown[])[5]).toBe(73)
    }
  })

  it('fences structured reads and worker-show to the resolved pairing revision', async () => {
    const updateFederatedDispatchRuntimeEpoch = vi.fn()
    const db = {
      updateFederatedDispatchRuntimeEpoch,
      captureFederatedDispatchObservationFence: (dispatchId: string) => ({
        dispatch_id: dispatchId
      }),
      projectFederatedDispatchObservation: (_fence: unknown, projection: () => void) => {
        projection()
        return true
      }
    } as unknown as OrchestrationDb
    const callOrchestrationWorkerServer = vi.fn(async (_selector, method: string) => {
      if (method === 'status.get') {
        return runtimeStatus([ORCHESTRATION_FEDERATION_STRUCTURED_READ_RUNTIME_CAPABILITY])
      }
      if (method === 'orchestration.federationShow') {
        return {
          runtimeEpoch: 'epoch-worker',
          attachment: {},
          terminal: null,
          observation: { status: 'live', exactWorker: true }
        }
      }
      return {
        runtimeEpoch: 'epoch-worker',
        output: { dispatchId: 'dispatch-worker', source: 'terminal' }
      }
    })
    const runtime = {
      callOrchestrationWorkerServer,
      resolveOrchestrationWorkerServer: () => server
    } as unknown as OrcaRuntimeService
    const federated = federatedDispatch()

    await readFederatedWorkerOutput({
      runtime,
      db,
      server,
      federated,
      dispatchId: federated.dispatch_id,
      source: undefined,
      cursor: undefined,
      limit: undefined
    })
    await callFederatedWorkerShow(runtime, federated)

    for (const call of callOrchestrationWorkerServer.mock.calls) {
      expect((call as unknown[])[5]).toEqual({ expectedEnvironmentPairingRevision: 73 })
    }
  })

  it('drops a structured-read epoch projection after its home fence is superseded', async () => {
    const updateFederatedDispatchRuntimeEpoch = vi.fn()
    const projectFederatedDispatchObservation = vi.fn().mockReturnValue(false)
    const db = {
      updateFederatedDispatchRuntimeEpoch,
      captureFederatedDispatchObservationFence: (dispatchId: string) => ({
        dispatch_id: dispatchId
      }),
      projectFederatedDispatchObservation
    } as unknown as OrchestrationDb
    const runtime = {
      callOrchestrationWorkerServer: vi.fn(async (_selector, method: string) =>
        method === 'status.get'
          ? runtimeStatus([ORCHESTRATION_FEDERATION_STRUCTURED_READ_RUNTIME_CAPABILITY])
          : {
              runtimeEpoch: 'epoch-stale',
              output: { dispatchId: 'dispatch-worker', source: 'terminal' }
            }
      )
    } as unknown as OrcaRuntimeService

    await readFederatedWorkerOutput({
      runtime,
      db,
      server,
      federated: federatedDispatch(),
      dispatchId: 'dispatch-worker',
      source: undefined,
      cursor: undefined,
      limit: undefined
    })

    expect(projectFederatedDispatchObservation).toHaveBeenCalledOnce()
    expect(updateFederatedDispatchRuntimeEpoch).not.toHaveBeenCalled()
  })

  it('rejects a mismatched release receipt before applying home effects', async () => {
    const transitionLifecycle = vi.fn()
    const db = {
      updateFederatedDispatchRuntimeEpoch: vi.fn(),
      transitionLifecycle
    }
    const callOrchestrationWorkerServer = vi.fn(async (_selector, method: string) =>
      method === 'status.get'
        ? runtimeStatus([ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY])
        : {
            dispatchId: 'dispatch-other',
            state: 'released',
            processAction: 'closed_agent_terminal',
            archive: null
          }
    )
    const runtime = {
      callOrchestrationWorkerServer,
      getOrchestrationDb: () => db
    } as unknown as OrcaRuntimeService

    const result = await releaseFederatedWorker({
      runtime,
      server,
      federated: federatedDispatch(),
      dispatchId: 'dispatch-worker',
      requestId: 'release-request'
    })

    expect(result).toMatchObject({
      dispatchId: 'dispatch-worker',
      state: 'release_unknown',
      processAction: 'none',
      lastError: expect.stringContaining('invalid release receipt')
    })
    expect(transitionLifecycle).not.toHaveBeenCalled()
    for (const call of callOrchestrationWorkerServer.mock.calls) {
      expect((call as unknown[])[5]).toEqual({ expectedEnvironmentPairingRevision: 73 })
    }
  })

  it('rejects malformed affirmative release receipts', () => {
    expect(() =>
      parseRemoteReleaseReceipt(
        { dispatchId: 'dispatch-worker', state: 'released', processAction: 'unknown' },
        'dispatch-worker'
      )
    ).toThrow('invalid release receipt')
  })

  it('fences lifecycle pull, acknowledgment, and import to one resolved pairing revision', async () => {
    const federated = federatedDispatch()
    const db = {
      getFederatedDispatch: () => federated,
      getDispatchContextById: () => ({ run_id: 'run-home', task_id: 'task-worker' }),
      importFederatedRelayItem: () => ({
        message: { read: 1, to_handle: 'run:run-home', type: 'status' },
        lifecycle: undefined,
        duplicate: false
      }),
      recordFederatedHomeAcknowledgment: vi.fn(),
      updateFederatedDispatchRuntimeEpoch: vi.fn(),
      getWorkerDispatch: () => ({ state: 'ready' }),
      listPendingFederationRelay: () => [
        {
          dispatch_id: federated.dispatch_id,
          direction: 'to_worker',
          sequence: 1,
          message_id: 'message-to-worker',
          kind: 'control_message',
          payload: '{}'
        }
      ],
      acknowledgeFederationRelay: vi.fn()
    }
    const callOrchestrationWorkerServer = vi.fn(async (_selector, method: string) => {
      if (method === 'status.get') {
        return runtimeStatus([])
      }
      if (method === 'orchestration.federationPull') {
        return {
          runtimeEpoch: 'epoch-worker',
          items: [
            {
              dispatch_id: federated.dispatch_id,
              direction: 'to_home',
              sequence: 1,
              message_id: 'message-home',
              kind: 'message',
              payload: JSON.stringify({ subject: 'status', body: 'ready', type: 'status' })
            }
          ]
        }
      }
      return { acknowledgedThrough: 1 }
    })
    const runtime = {
      getOrchestrationDb: () => db,
      resolveOrchestrationWorkerServer: () => server,
      callOrchestrationWorkerServer,
      notifyMessageArrived: vi.fn()
    } as unknown as OrcaRuntimeService

    await syncFederatedDispatch(runtime, federated.dispatch_id)

    expect(callOrchestrationWorkerServer.mock.calls.map((call) => call[1])).toEqual([
      'status.get',
      'orchestration.federationPull',
      'orchestration.federationAck',
      'orchestration.federationImport'
    ])
    for (const call of callOrchestrationWorkerServer.mock.calls) {
      expect((call as unknown[])[5]).toEqual({ expectedEnvironmentPairingRevision: 73 })
    }
  })

  it('fences stop preflight and effect calls to the resolved pairing revision', async () => {
    const db = {
      getFederatedDispatch: () => federatedDispatch(),
      beginWorkerStop: () => ({ disposition: 'stopping', worker: { state: 'stopping' } }),
      reconcileFederatedWorkerStop: () => ({ state: 'stopped' })
    }
    const callOrchestrationWorkerServer = vi.fn(async (_selector, method: string) =>
      method === 'status.get'
        ? runtimeStatus([ORCHESTRATION_WORKER_STOP_VERDICT_RUNTIME_CAPABILITY])
        : { state: 'stopped', alreadySettled: false, processAction: 'closed_agent_terminal' }
    )
    const runtime = {
      getOrchestrationDb: () => db,
      getRuntimeId: () => 'runtime-home',
      resolveOrchestrationWorkerServer: () => server,
      callOrchestrationWorkerServer
    } as unknown as OrcaRuntimeService
    const method = ORCHESTRATION_WORKER_STOP_METHODS.find(
      (candidate) => candidate.name === 'orchestration.workerStop'
    )!

    await method.handler(method.params!.parse({ dispatch: 'dispatch-worker' }), {
      runtime,
      orchestrationMutation: { requestId: 'request-stop' }
    } as never)

    for (const call of callOrchestrationWorkerServer.mock.calls) {
      expect((call as unknown[])[5]).toEqual({ expectedEnvironmentPairingRevision: 73 })
    }
  })
})

function federatedDispatch(): FederatedDispatchRow {
  return {
    dispatch_id: 'dispatch-worker',
    environment_id: server.environmentId,
    environment_name: server.name,
    peer_fingerprint: server.peerFingerprint,
    remote_runtime_epoch: 'epoch-worker',
    protocol_version: 3,
    remote_worktree_id: null,
    remote_terminal_handle: null,
    to_home_imported_sequence: 0,
    to_home_acknowledged_sequence: 0,
    created_at: '2026-08-27 00:00:00',
    updated_at: '2026-08-27 00:00:00'
  }
}

function runtimeStatus(capabilities: string[]) {
  return {
    runtimeId: 'epoch-worker',
    capabilities,
    rendererGraphEpoch: 0,
    graphStatus: 'ready' as const,
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0
  }
}
