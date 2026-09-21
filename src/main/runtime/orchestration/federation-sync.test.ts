import { describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from './db'
import {
  acquireFederationAckLease,
  getFederationAckedThrough,
  type FederationAckIdentity
} from './federation-ack-checkpoints'
import { createIdleSyncHarness } from './federation-sync-test-harness'
import { parseRelayedMessage, syncFederatedDispatch } from './federation-sync'
import { getOrchestrationPeerCapabilityCache } from './orchestration-peer-capability-cache'

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
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
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
          if (method === 'status.get') {
            return {
              runtimeId: 'remote_epoch_1',
              capabilities: [ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY]
            }
          }
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
  it('does not replay or settle a protocol-3 attachment after capability downgrade', async () => {
    const harness = createIdleSyncHarness(0, 3)
    harness.setRemoteCapabilities([])
    const calls = harness.remoteCall

    await harness.runtime.syncOrchestrationFederatedDispatch('dispatch_remote')
    const pull = calls.mock.calls.find(([, method]) => method === 'orchestration.federationPull')
    expect(pull?.[2]).not.toHaveProperty('replayUnacknowledged')
    expect(calls.mock.calls.some(([, method]) => method === 'orchestration.federationAck')).toBe(
      false
    )
  })

  it('retains a pending protocol-3 worker_done across restart downgrade and settles after support returns', async () => {
    let remoteRuntimeEpoch = 'remote_epoch_1'
    let remoteCapabilities = [ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY]
    let failNextAck = true
    const pending = [
      {
        dispatch_id: 'dispatch_remote',
        direction: 'to_home' as const,
        sequence: 1,
        message_id: 'msg_worker_done',
        kind: 'worker_done',
        payload: JSON.stringify({
          subject: 'Done',
          body: 'Finished',
          type: 'worker_done',
          payload: JSON.stringify({
            taskId: 'task_home',
            dispatchId: 'dispatch_remote',
            outcome: 'succeeded'
          })
        })
      },
      {
        dispatch_id: 'dispatch_remote',
        direction: 'to_home' as const,
        sequence: 2,
        message_id: 'msg_status_after_done',
        kind: 'status',
        payload: JSON.stringify({ subject: 'Status', body: 'Still around', type: 'status' })
      }
    ]
    const federated = {
      environment_id: 'environment_windows',
      environment_name: 'windows',
      peer_fingerprint: 'windows_peer_fingerprint',
      remote_runtime_epoch: remoteRuntimeEpoch,
      protocol_version: 3,
      to_home_imported_sequence: 0,
      to_home_acknowledged_sequence: 0
    }
    const db = {
      getFederatedDispatch: () => federated,
      getDispatchContextById: () => ({ run_id: 'run_home', task_id: 'task_home' }),
      getWorkerDispatch: () => ({ state: 'ready' }),
      listPendingFederationRelay: () => [],
      importFederatedRelayItem: ({
        sequence,
        message,
        lifecycle
      }: {
        sequence: number
        message: { to: string; type: 'status' | 'worker_done' }
        lifecycle:
          | { kind: 'none' }
          | { kind: 'heartbeat'; at: string }
          | { kind: 'worker_report'; outcome: 'succeeded' | 'failed' }
          | { kind: 'rejected'; code: string; reason: string }
      }) => {
        const duplicate = sequence <= federated.to_home_imported_sequence
        federated.to_home_imported_sequence = Math.max(
          federated.to_home_imported_sequence,
          sequence
        )
        return {
          message: { to_handle: message.to, type: message.type, read: 1 },
          duplicate,
          ...(lifecycle.kind === 'worker_report'
            ? { lifecycle: { action: 'settled' as const, outcome: lifecycle.outcome } }
            : {})
        }
      },
      recordFederatedHomeAcknowledgment: ({
        remoteRuntimeEpoch: epoch,
        sequence
      }: {
        remoteRuntimeEpoch: string
        sequence: number
      }) => {
        federated.remote_runtime_epoch = epoch
        federated.to_home_acknowledged_sequence = sequence
      },
      updateFederatedDispatchRuntimeEpoch: (_dispatchId: string, epoch: string) => {
        federated.remote_runtime_epoch = epoch
      }
    } as never
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      peerFingerprint: federated.peer_fingerprint
    } as never)
    const remoteCall = vi
      .spyOn(runtime, 'callOrchestrationWorkerServer')
      .mockImplementation(async (_environmentId, method, params) => {
        if (method === 'status.get') {
          return { runtimeId: remoteRuntimeEpoch, capabilities: remoteCapabilities }
        }
        if (method === 'orchestration.federationPull') {
          const replay = (params as { replayUnacknowledged?: boolean }).replayUnacknowledged
          return {
            runtimeEpoch: remoteRuntimeEpoch,
            items: pending.filter((item) =>
              replay
                ? item.sequence > federated.to_home_acknowledged_sequence
                : item.sequence > federated.to_home_imported_sequence
            )
          }
        }
        if (method === 'orchestration.federationAck') {
          const throughSequence = (params as { throughSequence: number }).throughSequence
          if (failNextAck) {
            failNextAck = false
            throw new Error('ack response lost before remote mutation')
          }
          pending.splice(
            0,
            pending.findIndex((item) => item.sequence > throughSequence) === -1
              ? pending.length
              : pending.findIndex((item) => item.sequence > throughSequence)
          )
          return { acknowledgedThrough: throughSequence }
        }
        throw new Error(`Unexpected method ${method}`)
      })

    await expect(syncFederatedDispatch(runtime, 'dispatch_remote')).rejects.toThrow(
      'ack response lost before remote mutation'
    )
    expect(federated.to_home_imported_sequence).toBe(2)
    expect(federated.to_home_acknowledged_sequence).toBe(0)

    remoteRuntimeEpoch = 'remote_epoch_2'
    remoteCapabilities = []
    await syncFederatedDispatch(runtime, 'dispatch_remote')
    expect(
      remoteCall.mock.calls.filter(([, method]) => method === 'orchestration.federationAck')
    ).toHaveLength(1)
    expect(pending).toHaveLength(2)

    remoteCapabilities = [ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY]
    await syncFederatedDispatch(runtime, 'dispatch_remote')
    expect(
      remoteCall.mock.calls
        .filter(([, method]) => method === 'orchestration.federationAck')
        .map(([, , params]) => params)
    ).toEqual([
      expect.objectContaining({ throughSequence: 2 }),
      expect.objectContaining({
        throughSequence: 2,
        settlements: [expect.objectContaining({ sequence: 1 })]
      })
    ])
    expect(pending).toHaveLength(0)
  })

  it('invalidates stale capabilities when an empty pull observes a restarted runtime', async () => {
    const { runtime, restartRemote, setRemoteCapabilities, getPersistedRemoteRuntimeEpoch } =
      createIdleSyncHarness(0)
    const cache = getOrchestrationPeerCapabilityCache(runtime)
    await cache.resolve({
      peerFingerprint: 'windows_peer_fingerprint',
      expectedRuntimeEpoch: 'remote_epoch_1',
      capability: ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY,
      probe: vi.fn().mockResolvedValue({ runtimeId: 'remote_epoch_1', capabilities: [] })
    })

    restartRemote()
    setRemoteCapabilities([
      ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY,
      ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY
    ])
    await runtime.syncOrchestrationFederatedDispatch('dispatch_remote')

    expect(getPersistedRemoteRuntimeEpoch()).toBe('remote_epoch_2')
    // The restart dropped the old epoch's answers, so the next resolve re-probes once and
    // then serves the new epoch from cache.
    const probe = vi.fn().mockResolvedValue({
      runtimeId: 'remote_epoch_2',
      capabilities: [ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY]
    })
    const resolveRelease = () =>
      cache.resolve({
        peerFingerprint: 'windows_peer_fingerprint',
        expectedRuntimeEpoch: 'remote_epoch_1',
        capability: ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY,
        probe
      })
    await expect(resolveRelease()).resolves.toMatchObject({
      runtimeEpoch: 'remote_epoch_2',
      supported: true,
      cached: false
    })
    await expect(resolveRelease()).resolves.toMatchObject({
      runtimeEpoch: 'remote_epoch_2',
      supported: true,
      cached: true
    })
    expect(probe).toHaveBeenCalledOnce()
  })

  it('probes an unchanged peer once across repeated syncs', async () => {
    const { runtime, remoteCall } = createIdleSyncHarness(0)

    await runtime.syncOrchestrationFederatedDispatch('dispatch_remote')
    await runtime.syncOrchestrationFederatedDispatch('dispatch_remote')
    await runtime.syncOrchestrationFederatedDispatch('dispatch_remote')

    expect(remoteCall.mock.calls.filter(([, method]) => method === 'status.get')).toHaveLength(1)
  })

  it('does not wake a waiter for an acknowledged duplicate replay', async () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Federation replay wake',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: 'tab_coordinator:11111111-1111-4111-8111-111111111111'
    })
    const task = db.createTask({ spec: 'Remote work', runId: run.id })
    const { dispatch } = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
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
        if (method === 'status.get') {
          return {
            runtimeId: 'remote_epoch_1',
            capabilities: [ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY]
          }
        }
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
      updateFederatedDispatchRuntimeEpoch: (_dispatchId: string, runtimeEpoch: string) => {
        federated.remote_runtime_epoch = runtimeEpoch
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
        if (method === 'status.get') {
          return {
            runtimeId: 'remote_epoch_1',
            capabilities: [ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY]
          }
        }
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
      'status.get',
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
})
