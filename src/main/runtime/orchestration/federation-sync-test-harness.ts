import { vi } from 'vitest'
import { ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { OrcaRuntimeService } from '../orca-runtime'

export function createIdleSyncHarness(initialSequence = 2, protocolVersion?: 1 | 2 | 3) {
  let remoteRuntimeEpoch = 'remote_epoch_1'
  let remoteCapabilities: string[] = [
    ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY
  ]
  let blockedAck: { reached: () => void; released: Promise<void> } | null = null
  let blockedPull: { reached: () => void; released: Promise<void> } | null = null
  let relayEligible = true
  const federated = {
    environment_id: 'environment_windows',
    environment_name: 'windows',
    peer_fingerprint: 'windows_peer_fingerprint',
    remote_runtime_epoch: remoteRuntimeEpoch,
    ...(protocolVersion ? { protocol_version: protocolVersion } : {}),
    to_home_imported_sequence: initialSequence,
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
      },
      updateFederatedDispatchRuntimeEpoch: (_dispatchId: string, runtimeEpoch: string) => {
        federated.remote_runtime_epoch = runtimeEpoch
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
