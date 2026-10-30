import {
  createPairedE2EEFramingPolicy,
  type PairedE2EEFramingPolicy
} from '../../../src/shared/paired-e2ee-framing-policy'
import {
  hydrateE2EEV2HostLatch,
  isHostLatchedToE2EEV2,
  latchHostToE2EEV2
} from './e2ee-v2-host-latch'

export function createDirectE2EEFramingPolicy(hostPublicKeyB64: string): PairedE2EEFramingPolicy {
  return createPairedE2EEFramingPolicy(hostPublicKeyB64, {
    hydrate: hydrateE2EEV2HostLatch,
    isLatched: isHostLatchedToE2EEV2,
    latch: latchHostToE2EEV2
  })
}
