import { afterEach, vi } from 'vitest'
import { OrchestrationDb, LEGACY_RUN_ID } from './db'
import { ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { OrcaRuntimeService } from '../orca-runtime'

const fixtureDatabases = new Set<OrchestrationDb>()
afterEach(() => {
  for (const db of fixtureDatabases) {
    db.close()
  }
  fixtureDatabases.clear()
})

export function createFederationSyncDatabase() {
  const db = new OrchestrationDb(':memory:')
  fixtureDatabases.add(db)
  const task = db.createTask({ runId: LEGACY_RUN_ID, spec: 'Federation fixture' })
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
  const federated = db.getFederatedDispatch(dispatch.id)!
  const context = db.getDispatchContextById(dispatch.id)!
  const worker = db.getWorkerDispatch(dispatch.id)!
  const message = db.insertMessage({ from: 'term_worker', to: 'term_home', subject: 'Fixture' })
  db.listActiveFederatedDispatches = () => []
  return { db, federated, context, worker, message }
}

export function createIdleSyncHarness(initialSequence = 2, protocolVersion?: 1 | 2 | 3) {
  let remoteRuntimeEpoch = 'remote_epoch_1'
  let remoteCapabilities: string[] = [
    ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY
  ]
  let blockedAck: { reached: () => void; released: Promise<void> } | null = null
  let blockedPull: { reached: () => void; released: Promise<void> } | null = null
  let relayEligible = true
  const fixture = createFederationSyncDatabase()
  const federated = {
    ...fixture.federated,
    environment_id: 'environment_windows',
    environment_name: 'windows',
    peer_fingerprint: 'windows_peer_fingerprint',
    remote_runtime_epoch: remoteRuntimeEpoch,
    ...(protocolVersion ? { protocol_version: protocolVersion } : {}),
    to_home_imported_sequence: initialSequence,
    to_home_acknowledged_sequence: 0
  }
  const createDb = (seed = createFederationSyncDatabase()) => {
    const { db, context, worker } = seed
    db.getFederatedDispatch = () => federated
    db.getDispatchContextById = () => ({ ...context, run_id: 'run_home', task_id: 'task_home' })
    db.getWorkerDispatch = () => ({ ...worker, state: 'ready' })
    db.listPendingFederationRelay = () => []
    db.isFederatedDispatchRelayEligible = () => relayEligible
    db.recordFederatedHomeAcknowledgment = (params) => {
      federated.remote_runtime_epoch = params.remoteRuntimeEpoch
      federated.to_home_acknowledged_sequence = params.sequence
    }
    db.updateFederatedDispatchRuntimeEpoch = (_dispatchId, runtimeEpoch) => {
      federated.remote_runtime_epoch = runtimeEpoch
    }
    return db
  }

  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(createDb(fixture))
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
      if (method === 'status.get') {
        return { runtimeId: remoteRuntimeEpoch, capabilities: remoteCapabilities }
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
    getPersistedRemoteRuntimeEpoch: () => federated.remote_runtime_epoch,
    settleDispatch: () => {
      relayEligible = false
    },
    setRemoteCapabilities: (capabilities: string[]) => {
      remoteCapabilities = capabilities
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
