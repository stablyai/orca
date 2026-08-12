import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import {
  acquireFederationAckLease,
  clearFederationAckCheckpoints,
  getFederationAckedThrough,
  recordFederationAckCheckpoint,
  type FederationAckIdentity
} from './federation-ack-checkpoints'
import { parseRelayedMessage } from './federation-sync'

function createIdleSyncHarness() {
  let remoteRuntimeEpoch = 'remote_epoch_1'
  let blockedAck: { reached: () => void; released: Promise<void> } | null = null
  let blockedPull: { reached: () => void; released: Promise<void> } | null = null
  const federated = {
    environment_id: 'environment_windows',
    environment_name: 'windows',
    peer_fingerprint: 'windows_peer_fingerprint',
    to_home_imported_sequence: 2
  }
  const createDb = () =>
    ({
      getFederatedDispatch: () => federated,
      getDispatchContextById: () => ({ run_id: 'run_home', task_id: 'task_home' }),
      getWorkerDispatch: () => ({ state: 'ready' }),
      listPendingFederationRelay: () => []
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
