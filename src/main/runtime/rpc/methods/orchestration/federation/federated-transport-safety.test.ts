import { describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY
} from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { OrcaRuntimeService } from '../../../../orca-runtime'

import type { FederatedDispatchRow } from '../../../../orchestration/db/orchestration-records'

import './federated-worker-read'
import { releaseFederatedWorker } from './federated-worker-release'
import '../worker/worker-observation'
import '../../../../orchestration/federation/synchronization/federation-sync'
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
})

describe('worker-stop of a remote worker already settled at home', () => {
  async function stopSettledRemote(helpers: Record<string, string[]>, rootHelpers?: unknown) {
    const db = {
      getFederatedDispatch: () => federatedDispatch(),
      beginWorkerStop: () => ({ disposition: 'already_settled', worker: { state: 'succeeded' } }),
      getWorkerDispatch: () => ({ state: 'succeeded' }),
      listHelperDispatchIds: (id: string) => helpers[id] ?? []
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stop reads only these runtime members.
    const runtime = {
      getOrchestrationDb: () => db,
      getRuntimeId: () => 'runtime-home',
      resolveOrchestrationWorkerServer: () => server,
      callOrchestrationWorkerServer: vi.fn(async (_selector, method: string, params) => {
        if (method === 'status.get') {
          return runtimeStatus(['orchestration.worker-stop-helpers.v1'])
        }
        if (method === 'orchestration.federationStop') {
          if (
            params.dispatchId === 'dispatch-worker' &&
            (helpers['dispatch-worker'] || rootHelpers)
          ) {
            return {
              state: 'succeeded',
              alreadySettled: true,
              processAction: 'none',
              helpers: rootHelpers
            }
          }
          throw new Error('timed out')
        }
        return { keptOpen: false }
      })
    } as unknown as OrcaRuntimeService
    const method = ORCHESTRATION_WORKER_STOP_METHODS[0]!
    return method.handler(method.params!.parse({ dispatch: 'dispatch-worker' }), {
      runtime,
      orchestrationMutation: { requestId: 'request-stop' }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only runtime and orchestrationMutation.
    } as never)
  }

  it('fails the stop when its host cannot be reached to stop its helpers', async () => {
    await expect(stopSettledRemote({})).resolves.toMatchObject({
      state: 'succeeded',
      alreadySettled: true,
      helperStopError: expect.stringContaining('timed out')
    })
  })

  it('fails the stop when a capable host returns an unreadable helper list', async () => {
    await expect(stopSettledRemote({}, 'not a list')).resolves.toMatchObject({
      helperStopError: expect.stringContaining('cannot read')
    })
  })

  it('reports a settled helper whose host could not stop its helpers as unconfirmed', async () => {
    await expect(
      stopSettledRemote({ 'dispatch-worker': ['dispatch-helper'] })
    ).resolves.toMatchObject({
      helpers: [
        {
          dispatchId: 'dispatch-helper',
          outcome: 'unconfirmed',
          lastError: expect.stringContaining('timed out')
        }
      ]
    })
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
    home_auto_release_at: null,
    home_auto_release_state: null,
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
