import type { PairedE2EEFramingPolicy } from '../../../src/shared/paired-e2ee-framing-policy'

// Pin legacy framing for simulated old hosts; rpc-client-direct-e2ee-v2 tests cover the default and fallback.
export function createDirectE2EEFramingPolicy(): PairedE2EEFramingPolicy {
  return {
    framingForNextDial: () => 'legacy',
    mayUseLegacy: () => true,
    helloRefusalIsAuthFailure: () => true,
    noteV2Authenticated: () => {},
    noteV2HelloRefused: () => {}
  }
}
