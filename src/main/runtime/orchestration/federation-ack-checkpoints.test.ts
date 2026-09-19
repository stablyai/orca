import { describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import {
  acquireFederationAckLease,
  clearFederationAckCheckpoints,
  getFederationAckedThrough,
  recordFederationAckCheckpoint,
  type FederationAckIdentity
} from './federation-ack-checkpoints'

describe('federation acknowledgment checkpoints', () => {
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
