import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from './db'
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
  let relayEligible = true
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
      isFederatedDispatchRelayEligible: () => relayEligible,
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
    settleDispatch: () => {
      relayEligible = false
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

  it.each(['escalation', 'decision_gate'] as const)(
    'binds an old remote %s payload to the imported Dispatch',
    async (type) => {
      const db = new OrchestrationDb(':memory:')
      const run = db.createRun({
        objective: 'Federated mutation binding',
        coordinatorHandle: 'term_coordinator',
        coordinatorPaneKey: 'tab_coordinator:11111111-1111-4111-8111-111111111111'
      })
      const task = db.createTask({ spec: 'Remote work', runId: run.id })
      const { dispatch } = db.createStartingWorkerDispatch({
        taskId: task.id,
        startOptions: {},
        federation: {
          environmentId: 'environment_windows',
          environmentName: 'windows',
          peerFingerprint: 'windows_peer_fingerprint',
          protocolVersion: 3
        }
      })
      db.recordWorkerStage({ dispatchId: dispatch.id, stage: 'ready', state: 'ready' })
      const runtime = new OrcaRuntimeService()
      runtime.setOrchestrationDb(db)
      vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
        peerFingerprint: 'windows_peer_fingerprint'
      } as never)
      vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockImplementation(
        async (_environmentId, method) => {
          if (method === 'orchestration.federationPull') {
            return {
              runtimeEpoch: 'remote_epoch_1',
              items: [
                {
                  dispatch_id: dispatch.id,
                  direction: 'to_home',
                  sequence: 1,
                  message_id: `msg_remote_${type}`,
                  kind: type,
                  payload: JSON.stringify({
                    subject: 'Remote control mutation',
                    body: '',
                    type,
                    payload: JSON.stringify({
                      taskId: task.id,
                      ...(type === 'decision_gate' ? { question: 'Proceed?' } : {})
                    })
                  })
                }
              ]
            }
          }
          if (method === 'orchestration.federationAck') {
            return { acknowledgedThrough: 1 }
          }
          throw new Error(`Unexpected method ${method}`)
        }
      )

      await syncFederatedDispatch(runtime, dispatch.id)

      expect(JSON.parse(db.getMessageById(`msg_remote_${type}`)!.payload!)).toMatchObject({
        taskId: task.id,
        dispatchId: dispatch.id
      })
      db.close()
    }
  )
})

describe('federation relay acknowledgments', () => {
  it('does not wake a waiter for an acknowledged duplicate replay', async () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Federation replay wake',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: 'tab_coordinator:11111111-1111-4111-8111-111111111111'
    })
    const task = db.createTask({ spec: 'Remote work', runId: run.id })
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      federation: {
        environmentId: 'environment_windows',
        environmentName: 'windows',
        peerFingerprint: 'windows_peer_fingerprint',
        protocolVersion: 3
      }
    })
    db.recordWorkerStage({ dispatchId: dispatch.id, stage: 'ready', state: 'ready' })
    const relayItem = (sequence: number) => ({
      dispatch_id: dispatch.id,
      direction: 'to_home' as const,
      sequence,
      message_id: `msg_federated_${sequence}`,
      kind: 'status',
      payload: JSON.stringify({
        subject: `Remote status ${sequence}`,
        body: `Update ${sequence}`,
        type: 'status'
      })
    })
    let pulled = [relayItem(1)]
    let rejectAck = true
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      peerFingerprint: 'windows_peer_fingerprint'
    } as never)
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockImplementation(
      async (_environmentId, method) => {
        if (method === 'orchestration.federationPull') {
          return { runtimeEpoch: 'remote_epoch_1', items: pulled }
        }
        if (method === 'orchestration.federationAck') {
          if (rejectAck) {
            rejectAck = false
            throw new Error('ack response lost before remote mutation')
          }
          return { acknowledgedThrough: pulled.at(-1)?.sequence ?? 0 }
        }
        throw new Error(`Unexpected method ${method}`)
      }
    )

    await expect(syncFederatedDispatch(runtime, dispatch.id)).rejects.toThrow(
      'ack response lost before remote mutation'
    )
    const first = db.getOrCreateRunDelivery({
      runId: run.id,
      consumerGeneration: run.consumer_generation
    })
    expect(first?.messages.map((message) => message.id)).toEqual(['msg_federated_1'])
    db.acknowledgeRunDelivery({
      runId: run.id,
      consumerGeneration: run.consumer_generation,
      deliveryId: first!.delivery.id
    })
    const waiting = runtime.waitForMessage(`run:${run.id}`, {
      typeFilter: ['status'],
      timeoutMs: 5_000
    })
    let settled = false
    void waiting.then(() => {
      settled = true
    })

    await syncFederatedDispatch(runtime, dispatch.id)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(db.getMessageById('msg_federated_1')?.read).toBe(1)

    pulled = [relayItem(2)]
    await syncFederatedDispatch(runtime, dispatch.id)
    await expect(waiting).resolves.toBe('notified')
    expect(db.getUnreadMessages(`run:${run.id}`).map((message) => message.id)).toEqual([
      'msg_federated_2'
    ])
    db.close()
  })

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

  it('releases the checkpoint once a dispatch is no longer relay eligible', async () => {
    const { runtime, settleDispatch } = createIdleSyncHarness()
    const identity: FederationAckIdentity = {
      environmentId: 'environment_windows',
      peerFingerprint: 'windows_peer_fingerprint',
      remoteRuntimeEpoch: 'remote_epoch_1'
    }
    const ackedThrough = () =>
      getFederationAckedThrough(acquireFederationAckLease(runtime, 'dispatch_remote'), identity)

    await runtime.syncOrchestrationFederatedDispatch('dispatch_remote')
    expect(ackedThrough()).toBe(2)

    settleDispatch()
    await runtime.syncOrchestrationFederatedDispatch('dispatch_remote')
    expect(ackedThrough()).toBe(0)
  })

  it('leaves the durable watermark suppressing acks after the checkpoint is released', async () => {
    const { runtime, remoteCall, settleDispatch } = createIdleSyncHarness()
    const ackCalls = () =>
      remoteCall.mock.calls.filter(([, method]) => method === 'orchestration.federationAck')

    await runtime.syncOrchestrationFederatedDispatch('dispatch_remote')
    expect(ackCalls()).toHaveLength(1)

    settleDispatch()
    await runtime.syncOrchestrationFederatedDispatch('dispatch_remote')
    await runtime.syncOrchestrationFederatedDispatch('dispatch_remote')

    expect(ackCalls()).toHaveLength(1)
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
