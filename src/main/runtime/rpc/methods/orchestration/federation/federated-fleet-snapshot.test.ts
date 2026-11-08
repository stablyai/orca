import { describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY } from '../../../../../../shared/orchestration-runtime-capabilities'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { FederatedDispatchRow } from '../../../../orchestration/db/orchestration-records'
import '../../../../../../shared/orchestration-fleet-projection'
import { readFederatedFleetSnapshots } from './federated-fleet-snapshot'

describe('federated fleet snapshots', () => {
  it('does not grant a snapshot call budget after the fleet deadline expires', async () => {
    // Exceed concurrency so the final peer cannot start before the fleet budget expires.
    const dispatchIds = Array.from({ length: 5 }, (_, index) => `dispatch-expired-${index}`)
    const dispatches = new Map(
      dispatchIds.map((dispatchId) => [
        dispatchId,
        {
          ...federatedDispatch(dispatchId, `peer-${dispatchId}`, 'epoch-a'),
          environment_id: dispatchId
        }
      ])
    )
    const db = {
      listFederatedDispatchesByIds: (ids: readonly string[]) =>
        ids.flatMap((id) => (dispatches.get(id) ? [dispatches.get(id)!] : [])),
      updateFederatedDispatchRuntimeEpoch: vi.fn(),
      ...observationFenceMethods()
    } as unknown as OrchestrationDb
    let now = 1_000
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const runtime = {
      resolveOrchestrationWorkerServer: (environmentId: string) => ({
        environmentId,
        name: 'repointed',
        peerFingerprint: `peer-${environmentId}`,
        pairingRevision: 1
      }),
      callOrchestrationWorkerServer: vi.fn(
        async (_environmentId: string, _method: string, params: unknown) => {
          now += 5_001
          return {
            runtimeEpoch: 'epoch-a',
            items: (params as { dispatchIds: string[] }).dispatchIds.map((dispatchId) => ({
              dispatchId,
              observation: { status: 'live' as const, exactWorker: true }
            }))
          }
        }
      )
    } as unknown as OrcaRuntimeService

    try {
      const result = await readFederatedFleetSnapshots({ runtime, db, dispatchIds })

      // Orca never contacted these hosts, so calling them unavailable would fabricate a verdict.
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors.map((error) => error.code)).toEqual(
        result.errors.map(() => 'home_budget_exhausted')
      )
      expect(result.errors.flatMap((error) => error.dispatchIds)).toContain('dispatch-expired-4')
    } finally {
      dateNow.mockRestore()
    }
  })

  it('partitions a repointed environment by pinned peer identity', async () => {
    const dispatches = new Map([
      ['dispatch-a', federatedDispatch('dispatch-a', 'peer-a', 'epoch-a')],
      ['dispatch-b', federatedDispatch('dispatch-b', 'peer-b', 'epoch-b')]
    ])
    const updateFederatedDispatchRuntimeEpoch = vi.fn()
    const db = {
      listFederatedDispatchesByIds: (ids: readonly string[]) =>
        ids.flatMap((id) => (dispatches.get(id) ? [dispatches.get(id)!] : [])),
      updateFederatedDispatchRuntimeEpoch,
      ...observationFenceMethods()
    } as unknown as OrchestrationDb
    const callOrchestrationWorkerServer = vi.fn(
      async (_environmentId: string, method: string, params: unknown) => {
        if (method === 'status.get') {
          return runtimeStatus('epoch-b')
        }
        expect(method).toBe('orchestration.federationFleetSnapshot')
        const dispatchIds = (params as { dispatchIds: string[] }).dispatchIds
        return {
          runtimeEpoch: 'epoch-b',
          items: dispatchIds.map((dispatchId) => ({
            dispatchId,
            observation: { status: 'live' as const, exactWorker: true }
          }))
        }
      }
    )
    const runtime = {
      resolveOrchestrationWorkerServer: () => ({
        environmentId: 'environment-repointed',
        name: 'repointed',
        peerFingerprint: 'peer-b',
        pairingRevision: 42
      }),
      callOrchestrationWorkerServer
    } as unknown as OrcaRuntimeService

    const result = await readFederatedFleetSnapshots({
      runtime,
      db,
      dispatchIds: ['dispatch-a', 'dispatch-b']
    })

    expect(result.errors).toEqual([
      expect.objectContaining({
        environmentId: 'environment-repointed',
        code: 'peer_changed',
        dispatchIds: ['dispatch-a']
      })
    ])
    expect(result.observations.get('dispatch-a')).toBeUndefined()
    expect(result.observations.get('dispatch-b')).toEqual({ status: 'live', exactWorker: true })
    for (const call of callOrchestrationWorkerServer.mock.calls) {
      expect((call as unknown[])[5]).toEqual({ expectedEnvironmentPairingRevision: 42 })
    }
    expect(callOrchestrationWorkerServer).toHaveBeenCalledWith(
      'environment-repointed',
      'orchestration.federationFleetSnapshot',
      { dispatchIds: ['dispatch-b'] },
      expect.any(Number),
      undefined,
      { expectedEnvironmentPairingRevision: 42 }
    )
    expect(updateFederatedDispatchRuntimeEpoch).toHaveBeenCalledWith('dispatch-b', 'epoch-b')
    expect(updateFederatedDispatchRuntimeEpoch).not.toHaveBeenCalledWith(
      'dispatch-a',
      expect.any(String)
    )
  })

  it('records a method-not-found result at the pinned runtime epoch', async () => {
    const dispatch = federatedDispatch('dispatch-unsupported', 'peer-a', 'epoch-old')
    const updateFederatedDispatchRuntimeEpoch = vi.fn()
    const db = {
      listFederatedDispatchesByIds: (ids: readonly string[]) => ids.map(() => dispatch),
      updateFederatedDispatchRuntimeEpoch,
      ...observationFenceMethods()
    } as unknown as OrchestrationDb
    const runtime = {
      resolveOrchestrationWorkerServer: () => ({
        environmentId: dispatch.environment_id,
        name: dispatch.environment_name,
        peerFingerprint: dispatch.peer_fingerprint,
        pairingRevision: 1
      }),
      callOrchestrationWorkerServer: vi.fn(async () => {
        throw new OrchestrationError('method_not_found', 'fleet snapshot unavailable')
      })
    } as unknown as OrcaRuntimeService

    const result = await readFederatedFleetSnapshots({
      runtime,
      db,
      dispatchIds: [dispatch.dispatch_id]
    })

    expect(result.errors).toEqual([expect.objectContaining({ code: 'capability_unsupported' })])
    expect(updateFederatedDispatchRuntimeEpoch).toHaveBeenCalledWith(
      dispatch.dispatch_id,
      'epoch-old'
    )
  })
})

function federatedDispatch(
  dispatchId: string,
  peerFingerprint: string,
  remoteRuntimeEpoch: string
): FederatedDispatchRow {
  return {
    dispatch_id: dispatchId,
    environment_id: 'environment-repointed',
    environment_name: 'repointed',
    peer_fingerprint: peerFingerprint,
    remote_runtime_epoch: remoteRuntimeEpoch,
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

function runtimeStatus(runtimeId: string) {
  return {
    runtimeId,
    capabilities: [ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY],
    rendererGraphEpoch: 0,
    graphStatus: 'ready' as const,
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0
  }
}

function observationFenceMethods() {
  return {
    captureFederatedDispatchObservationFences: (dispatchIds: readonly string[]) =>
      new Map(dispatchIds.map((dispatchId) => [dispatchId, { dispatch_id: dispatchId }])),
    projectFederatedDispatchObservation: (_fence: unknown, projection: () => void) => {
      projection()
      return true
    }
  }
}
