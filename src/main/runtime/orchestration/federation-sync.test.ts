import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import {
  acquireFederationAckLease,
  clearFederationAckCheckpoints,
  getFederationAckedThrough,
  recordFederationAckCheckpoint,
  type FederationAckIdentity
} from './federation-ack-checkpoints'
import { parseRelayedMessage, syncFederatedDispatch } from './federation-sync'

function createIdleSyncHarness() {
  let remoteRuntimeEpoch = 'remote_epoch_1'
  let blockedAck: { reached: () => void; released: Promise<void> } | null = null
  let blockedPull: { reached: () => void; released: Promise<void> } | null = null
  const federated = {
    environment_id: 'environment_windows',
    environment_name: 'windows',
    peer_fingerprint: 'windows_peer_fingerprint',
    remote_runtime_epoch: remoteRuntimeEpoch,
    to_home_imported_sequence: 2,
    to_home_acknowledged_sequence: 0
  }
  const createDb = () =>
    ({
      getFederatedDispatch: () => federated,
      getDispatchContextById: () => ({ run_id: 'run_home', task_id: 'task_home' }),
      getWorkerDispatch: () => ({ state: 'ready' }),
      listPendingFederationRelay: () => [],
      recordFederatedHomeAcknowledgment: (params: {
        remoteRuntimeEpoch: string
        sequence: number
      }) => {
        federated.remote_runtime_epoch = params.remoteRuntimeEpoch
        federated.to_home_acknowledged_sequence = params.sequence
      }
    }) as never
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(createDb())
  vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
    peerFingerprint: federated.peer_fingerprint
  } as never)
  const remoteCall = vi
    .spyOn(runtime, 'callOrchestrationWorkerServer')
    .mockImplementation(async (_environmentId, method) => {
      if (method === 'orchestration.federationPull') {
        const gate = blockedPull
        if (gate) {
          gate.reached()
          await gate.released
          if (blockedPull === gate) {
            blockedPull = null
          }
        }
        return { runtimeEpoch: remoteRuntimeEpoch, items: [] }
      }
      if (method === 'orchestration.federationAck') {
        const gate = blockedAck
        if (gate) {
          gate.reached()
          await gate.released
          if (blockedAck === gate) {
            blockedAck = null
          }
        }
        return { acknowledgedThrough: federated.to_home_imported_sequence }
      }
      throw new Error(`Unexpected method ${method}`)
    })
  return {
    runtime,
    remoteCall,
    advanceCursor: () => {
      federated.to_home_imported_sequence += 1
    },
    restartRemote: () => {
      remoteRuntimeEpoch = 'remote_epoch_2'
    },
    replaceDb: () => runtime.setOrchestrationDb(createDb()),
    blockAck: () => {
      let noteReached!: () => void
      let release!: () => void
      const reached = new Promise<void>((resolve) => (noteReached = resolve))
      const released = new Promise<void>((resolve) => (release = resolve))
      blockedAck = { reached: noteReached, released }
      return { reached, release }
    },
    blockPull: () => {
      let noteReached!: () => void
      let release!: () => void
      const reached = new Promise<void>((resolve) => (noteReached = resolve))
      const released = new Promise<void>((resolve) => (release = resolve))
      blockedPull = { reached: noteReached, released }
      return { reached, release }
    }
  }
}

describe('federation relay parsing', () => {
  it('accepts a supported message type', () => {
    expect(
      parseRelayedMessage(
        JSON.stringify({ subject: 'done', body: 'Finished', type: 'worker_done' })
      )
    ).toMatchObject({ type: 'worker_done', priority: 'normal' })
  })

  it('rejects an unsupported type before it reaches the database constraint', () => {
    expect(() =>
      parseRelayedMessage(JSON.stringify({ subject: 'bad', body: 'Blocked', type: 'invented' }))
    ).toThrowError('Federated relay message type invented is not supported.')
  })
})

describe('federation relay acknowledgments', () => {
  it('drains a terminal retry from the page after the first terminal report', async () => {
    const pending = Array.from({ length: 51 }, (_, index) => {
      const sequence = index + 1
      const terminal = sequence >= 50
      return {
        dispatch_id: 'dispatch_remote',
        direction: 'to_home' as const,
        sequence,
        message_id: `message_${sequence}`,
        kind: terminal ? 'worker_done' : 'status',
        payload: JSON.stringify({
          subject: terminal ? 'Done' : 'Progress',
          body: terminal ? `Attempt ${sequence}` : `Update ${sequence}`,
          type: terminal ? 'worker_done' : 'status',
          ...(terminal
            ? {
                payload: JSON.stringify({
                  taskId: 'task_home',
                  dispatchId: 'dispatch_remote',
                  outcome: 'succeeded'
                })
              }
            : {})
        })
      }
    })
    const federated = {
      environment_id: 'environment_windows',
      environment_name: 'windows',
      peer_fingerprint: 'windows_peer_fingerprint',
      remote_runtime_epoch: 'remote_epoch_1',
      protocol_version: 3,
      to_home_imported_sequence: 0,
      to_home_acknowledged_sequence: 0
    }
    let pendingToWorker = [{ sequence: 1 }]
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb({
      getFederatedDispatch: () => federated,
      getDispatchContextById: () => ({ run_id: 'run_home', task_id: 'task_home' }),
      importFederatedRelayItem: ({
        sequence,
        message,
        lifecycle
      }: {
        sequence: number
        message: { to: string; type: 'status' | 'worker_done' }
        lifecycle:
          | { kind: 'worker_report'; outcome: 'succeeded' | 'failed' }
          | { kind: 'none' | 'heartbeat' | 'rejected' }
      }) => {
        federated.to_home_imported_sequence = sequence
        return {
          message: { to_handle: message.to, type: message.type },
          duplicate: false,
          ...(lifecycle.kind === 'worker_report'
            ? { lifecycle: { action: 'settled', outcome: lifecycle.outcome } }
            : {})
        }
      },
      recordFederatedHomeAcknowledgment: ({ sequence }: { sequence: number }) => {
        federated.to_home_acknowledged_sequence = sequence
      },
      getWorkerDispatch: () => ({ state: 'ready' }),
      listPendingFederationRelay: () => pendingToWorker,
      acknowledgeFederationRelay: () => {
        pendingToWorker = []
      }
    } as never)
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      peerFingerprint: federated.peer_fingerprint
    } as never)
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    const remoteCall = vi
      .spyOn(runtime, 'callOrchestrationWorkerServer')
      .mockImplementation(async (_environmentId, method, params) => {
        if (method === 'orchestration.federationPull') {
          return { runtimeEpoch: 'remote_epoch_1', items: pending.slice(0, 50) }
        }
        if (method === 'orchestration.federationAck') {
          const throughSequence = (params as { throughSequence: number }).throughSequence
          pending.splice(
            0,
            pending.findIndex((item) => item.sequence > throughSequence) === -1
              ? pending.length
              : pending.findIndex((item) => item.sequence > throughSequence)
          )
          return { acknowledgedThrough: throughSequence }
        }
        if (method === 'orchestration.federationImport') {
          return { acknowledgedThrough: 1 }
        }
        throw new Error(`Unexpected method ${method}`)
      })

    const result = await syncFederatedDispatch(runtime, 'dispatch_remote')

    expect(result).toEqual({ imported: 51, acknowledgedThrough: 51 })
    expect(pending).toHaveLength(0)
    expect(remoteCall.mock.calls.map(([, method]) => method)).toEqual([
      'orchestration.federationPull',
      'orchestration.federationAck',
      'orchestration.federationImport',
      'orchestration.federationPull',
      'orchestration.federationAck'
    ])
    expect(
      remoteCall.mock.calls
        .filter(([, method]) => method === 'orchestration.federationAck')
        .map(([, , params]) => params)
    ).toEqual([
      expect.objectContaining({ throughSequence: 50 }),
      expect.objectContaining({
        throughSequence: 51,
        settlements: [expect.objectContaining({ sequence: 51 })]
      })
    ])
  })

  it('acknowledges only new progress until remote runtime identity changes', async () => {
    const { runtime, remoteCall, advanceCursor, restartRemote } = createIdleSyncHarness()
    const ackCalls = () =>
      remoteCall.mock.calls.filter(([, method]) => method === 'orchestration.federationAck')

    await runtime.syncOrchestrationFederatedDispatch('dispatch_remote')
    await runtime.syncOrchestrationFederatedDispatch('dispatch_remote')
    expect(ackCalls()).toHaveLength(1)

    advanceCursor()
    await runtime.syncOrchestrationFederatedDispatch('dispatch_remote')
    expect(ackCalls()).toHaveLength(2)

    restartRemote()
    await runtime.syncOrchestrationFederatedDispatch('dispatch_remote')
    expect(ackCalls().map(([, , params]) => params)).toEqual([
      { dispatchId: 'dispatch_remote', throughSequence: 2 },
      { dispatchId: 'dispatch_remote', throughSequence: 3 },
      { dispatchId: 'dispatch_remote', throughSequence: 3 }
    ])
  })

  it('coalesces overlapping syncs while an acknowledgment is in flight', async () => {
    const { runtime, remoteCall, blockAck } = createIdleSyncHarness()
    const gate = blockAck()

    const first = runtime.syncOrchestrationFederatedDispatch('dispatch_remote')
    await gate.reached
    const second = runtime.syncOrchestrationFederatedDispatch('dispatch_remote')
    expect(second).toBe(first)
    gate.release()
    await Promise.all([first, second])

    expect(
      remoteCall.mock.calls.filter(([, method]) => method === 'orchestration.federationAck')
    ).toHaveLength(1)
  })

  it('pulls again after a sync that predates a terminal observation', async () => {
    const { runtime, remoteCall, blockPull } = createIdleSyncHarness()
    const gate = blockPull()

    const oldSync = runtime.syncOrchestrationFederatedDispatch('dispatch_remote')
    await gate.reached
    const freshSync = runtime.syncOrchestrationFederatedDispatchAfterCurrent('dispatch_remote')
    expect(
      remoteCall.mock.calls.filter(([, method]) => method === 'orchestration.federationPull')
    ).toHaveLength(1)
    gate.release()
    await Promise.all([oldSync, freshSync])

    expect(
      remoteCall.mock.calls.filter(([, method]) => method === 'orchestration.federationPull')
    ).toHaveLength(2)
    expect(
      remoteCall.mock.calls.filter(([, method]) => method === 'orchestration.federationAck')
    ).toHaveLength(1)
  })

  it('starts a new sync when the orchestration database changes in flight', async () => {
    const { runtime, remoteCall, blockAck, replaceDb } = createIdleSyncHarness()
    const gate = blockAck()

    const oldSync = runtime.syncOrchestrationFederatedDispatch('dispatch_remote')
    await gate.reached
    replaceDb()
    const newSync = runtime.syncOrchestrationFederatedDispatch('dispatch_remote')
    expect(newSync).not.toBe(oldSync)
    await vi.waitFor(() =>
      expect(
        remoteCall.mock.calls.filter(([, method]) => method === 'orchestration.federationAck')
      ).toHaveLength(2)
    )
    gate.release()
    await Promise.all([oldSync, newSync])
    await runtime.syncOrchestrationFederatedDispatch('dispatch_remote')

    expect(
      remoteCall.mock.calls.filter(([, method]) => method === 'orchestration.federationAck')
    ).toHaveLength(2)
  })

  it('starts a new sync when relay state resets in flight', async () => {
    const { runtime, remoteCall, blockAck } = createIdleSyncHarness()
    const gate = blockAck()

    const oldSync = runtime.syncOrchestrationFederatedDispatch('dispatch_remote')
    await gate.reached
    runtime.stopOrchestrationFederationRelay()
    const newSync = runtime.syncOrchestrationFederatedDispatch('dispatch_remote')
    expect(newSync).not.toBe(oldSync)
    await vi.waitFor(() =>
      expect(
        remoteCall.mock.calls.filter(([, method]) => method === 'orchestration.federationAck')
      ).toHaveLength(2)
    )
    gate.release()
    await Promise.all([oldSync, newSync])
    await runtime.syncOrchestrationFederatedDispatch('dispatch_remote')

    expect(
      remoteCall.mock.calls.filter(([, method]) => method === 'orchestration.federationAck')
    ).toHaveLength(2)
  })

  it('matches checkpoints only to their exact remote identity and never moves backward', () => {
    const runtime = {} as OrcaRuntimeService
    const identity: FederationAckIdentity = {
      environmentId: 'environment_windows',
      peerFingerprint: 'windows_peer_fingerprint',
      remoteRuntimeEpoch: 'remote_epoch_1'
    }
    const lease = acquireFederationAckLease(runtime, 'dispatch_remote')
    recordFederationAckCheckpoint(runtime, lease, {
      ...identity,
      throughSequence: 2
    })

    recordFederationAckCheckpoint(runtime, lease, {
      ...identity,
      throughSequence: 3
    })
    recordFederationAckCheckpoint(runtime, lease, {
      ...identity,
      throughSequence: 2
    })

    expect(getFederationAckedThrough(lease, identity)).toBe(3)
    expect(
      getFederationAckedThrough(lease, { ...identity, remoteRuntimeEpoch: 'remote_epoch_2' })
    ).toBe(0)
    expect(
      getFederationAckedThrough(lease, { ...identity, peerFingerprint: 'replacement_peer' })
    ).toBe(0)
    expect(getFederationAckedThrough(lease, { ...identity, environmentId: 'replacement' })).toBe(0)
  })

  it('fences delayed writes after runtime reset', () => {
    const runtime = {} as OrcaRuntimeService
    const identity: FederationAckIdentity = {
      environmentId: 'environment_windows',
      peerFingerprint: 'windows_peer_fingerprint',
      remoteRuntimeEpoch: 'remote_epoch_1'
    }
    const staleRuntimeLease = acquireFederationAckLease(runtime, 'dispatch_remote')
    clearFederationAckCheckpoints(runtime)
    recordFederationAckCheckpoint(runtime, staleRuntimeLease, {
      ...identity,
      throughSequence: 2
    })
    expect(
      getFederationAckedThrough(acquireFederationAckLease(runtime, 'dispatch_remote'), identity)
    ).toBe(0)
  })
})
