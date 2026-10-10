import { describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { FederatedDispatchRow } from '../../../../orchestration/types'
import { projectOrchestrationFleet } from '../../../../../../shared/orchestration-fleet-projection'
import {
  applyFederatedFleetObservations,
  readFederatedFleetSnapshots
} from './federated-fleet-snapshot'

describe('federated fleet snapshots', () => {
  it('batches a complete legacy fleet result to the host RPC maximum', async () => {
    const dispatchIds = Array.from(
      { length: 101 },
      (_, index) => `dispatch-${String(index).padStart(3, '0')}`
    )
    const dispatches = new Map(
      dispatchIds.map((dispatchId) => [
        dispatchId,
        federatedDispatch(dispatchId, 'peer-a', 'epoch-a')
      ])
    )
    const db = {
      listFederatedDispatchesByIds: (ids: readonly string[]) =>
        ids.flatMap((id) => (dispatches.get(id) ? [dispatches.get(id)!] : [])),
      updateFederatedDispatchRuntimeEpoch: vi.fn(),
      ...observationFenceMethods()
    } as unknown as OrchestrationDb
    const fleetBatchSizes: number[] = []
    const runtime = {
      resolveOrchestrationWorkerServer: () => ({
        environmentId: 'environment-repointed',
        name: 'repointed',
        peerFingerprint: 'peer-a',
        pairingRevision: 1
      }),
      callOrchestrationWorkerServer: vi.fn(
        async (_environmentId: string, method: string, params: unknown) => {
          if (method === 'status.get') {
            return runtimeStatus('epoch-a')
          }
          const batch = (params as { dispatchIds: string[] }).dispatchIds
          fleetBatchSizes.push(batch.length)
          return {
            runtimeEpoch: 'epoch-a',
            items: batch.map((dispatchId) => ({
              dispatchId,
              observation: { status: 'live' as const, exactWorker: true }
            }))
          }
        }
      )
    } as unknown as OrcaRuntimeService

    const result = await readFederatedFleetSnapshots({ runtime, db, dispatchIds })

    expect(fleetBatchSizes.toSorted((left, right) => right - left)).toEqual([100, 1])
    expect(result.errors).toEqual([])
    expect(result.observations).toHaveLength(101)
  })

  it('asks the snapshot method directly instead of probing status.get', async () => {
    const dispatch = federatedDispatch('dispatch-optimistic', 'peer-optimistic', 'epoch-a')
    const db = {
      listFederatedDispatchesByIds: (ids: readonly string[]) => ids.map(() => dispatch),
      updateFederatedDispatchRuntimeEpoch: vi.fn(),
      ...observationFenceMethods()
    } as unknown as OrchestrationDb
    const methods: string[] = []
    const runtime = {
      resolveOrchestrationWorkerServer: () => ({
        environmentId: dispatch.environment_id,
        name: dispatch.environment_name,
        peerFingerprint: dispatch.peer_fingerprint,
        pairingRevision: 1
      }),
      callOrchestrationWorkerServer: vi.fn(async (_environmentId: string, method: string) => {
        methods.push(method)
        return {
          runtimeEpoch: 'epoch-a',
          items: [
            {
              dispatchId: dispatch.dispatch_id,
              observation: { status: 'live' as const, exactWorker: true }
            }
          ]
        }
      })
    } as unknown as OrcaRuntimeService

    const result = await readFederatedFleetSnapshots({
      runtime,
      db,
      dispatchIds: [dispatch.dispatch_id]
    })

    expect(methods).toEqual(['orchestration.federationFleetSnapshot'])
    expect(result.observations.get(dispatch.dispatch_id)).toEqual({
      status: 'live',
      exactWorker: true
    })
  })

  it('does not grant a snapshot call budget after the fleet deadline expires', async () => {
    // Five distinct peers exceed the host concurrency, so the last one only starts after the
    // first wave has already spent the whole fleet budget.
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

  it('does not overwrite a confirmed release with later host unavailability', () => {
    const fleet = projectOrchestrationFleet({
      workers: [
        {
          dispatchId: 'dispatch-released',
          taskId: 'task-released',
          runId: 'run-home',
          parentTaskId: null,
          workerState: 'succeeded',
          dispatchStatus: 'completed',
          workerStage: 'released',
          agentTerminalHandle: null,
          paneKey: null,
          worktreeId: null,
          terminalState: 'released',
          resource: null
        }
      ],
      statuses: [],
      now: 1
    })

    applyFederatedFleetObservations(
      fleet,
      {
        observations: new Map(),
        errors: [
          {
            environmentId: 'environment-offline',
            name: 'offline',
            code: 'host_unavailable',
            dispatchIds: ['dispatch-released']
          }
        ],
        hosts: new Map([['dispatch-released', 'environment-offline']])
      },
      new Map()
    )

    expect(fleet.workers[0]).toMatchObject({
      host: { kind: 'remote', id: 'environment-offline' },
      liveness: { verdict: 'exited', source: 'execution_host' },
      evidence: { liveStatus: 'unavailable', lastObservedAt: null }
    })
  })

  it('drops a fleet epoch projection after its home fence is superseded', async () => {
    const dispatch = federatedDispatch('dispatch-stale', 'peer-a', 'epoch-new')
    const updateFederatedDispatchRuntimeEpoch = vi.fn()
    const projectFederatedDispatchObservation = vi.fn().mockReturnValue(false)
    const db = {
      listFederatedDispatchesByIds: (ids: readonly string[]) => ids.map(() => dispatch),
      updateFederatedDispatchRuntimeEpoch,
      captureFederatedDispatchObservationFences: (ids: readonly string[]) =>
        new Map(ids.map((id) => [id, { dispatch_id: id }])),
      projectFederatedDispatchObservation
    } as unknown as OrchestrationDb
    const runtime = {
      resolveOrchestrationWorkerServer: () => ({
        environmentId: dispatch.environment_id,
        name: dispatch.environment_name,
        peerFingerprint: dispatch.peer_fingerprint,
        pairingRevision: 1
      }),
      callOrchestrationWorkerServer: vi.fn(async (_environmentId, method: string) =>
        method === 'status.get'
          ? runtimeStatus('epoch-stale')
          : {
              runtimeEpoch: 'epoch-stale',
              items: [
                {
                  dispatchId: dispatch.dispatch_id,
                  observation: { status: 'live' as const, exactWorker: true }
                }
              ]
            }
      )
    } as unknown as OrcaRuntimeService

    const result = await readFederatedFleetSnapshots({
      runtime,
      db,
      dispatchIds: [dispatch.dispatch_id]
    })

    expect(result.observations.has(dispatch.dispatch_id)).toBe(false)
    expect(projectFederatedDispatchObservation).toHaveBeenCalledOnce()
    expect(updateFederatedDispatchRuntimeEpoch).not.toHaveBeenCalled()
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

  it('keeps each host failure a distinct fleet reason', async () => {
    const scenarios = [
      {
        dispatchId: 'dispatch-unsupported',
        fail: () => new OrchestrationError('method_not_found', 'fleet snapshot unavailable'),
        reason: 'capability_unsupported'
      },
      {
        dispatchId: 'dispatch-repointed',
        fail: () => new OrchestrationError('peer_changed', 'environment now names another server'),
        reason: 'peer_changed'
      },
      {
        dispatchId: 'dispatch-offline',
        fail: () => new Error('socket hang up'),
        reason: 'host_unavailable'
      }
    ] as const

    for (const scenario of scenarios) {
      const dispatch = federatedDispatch(scenario.dispatchId, 'peer-a', 'epoch-a')
      const db = {
        listFederatedDispatchesByIds: (ids: readonly string[]) => ids.map(() => dispatch),
        updateFederatedDispatchRuntimeEpoch: vi.fn(),
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
          throw scenario.fail()
        })
      } as unknown as OrcaRuntimeService

      const federated = await readFederatedFleetSnapshots({
        runtime,
        db,
        dispatchIds: [scenario.dispatchId]
      })
      const fleet = projectOrchestrationFleet({
        workers: [runningFederatedWorker(scenario.dispatchId)],
        statuses: [],
        now: 1
      })

      applyFederatedFleetObservations(fleet, federated, new Map())

      expect({ dispatchId: scenario.dispatchId, liveness: fleet.workers[0].liveness }).toEqual({
        dispatchId: scenario.dispatchId,
        liveness: { verdict: 'unverifiable', reason: scenario.reason }
      })
    }
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

function runningFederatedWorker(dispatchId: string) {
  return {
    dispatchId,
    taskId: `task-${dispatchId}`,
    runId: 'run-home',
    parentTaskId: null,
    workerState: 'running',
    dispatchStatus: 'dispatched',
    workerStage: 'working',
    agentTerminalHandle: 'handle-remote',
    paneKey: 'pane-remote',
    worktreeId: 'worktree-remote',
    terminalState: 'active' as const,
    resource: null
  }
}
