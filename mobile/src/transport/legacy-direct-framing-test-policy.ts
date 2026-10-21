import type { PairedE2EEFramingPolicy } from '../../../src/shared/paired-e2ee-framing-policy'

// Why: transport tests that model a host answering legacy framing pin it here;
// rpc-client-direct-e2ee-v2.test.ts covers the v2 default and its fallback rules.
export function createDirectE2EEFramingPolicy(): PairedE2EEFramingPolicy {
  return {
    framingForNextDial: () => 'legacy',
    mayUseLegacy: () => true,
    helloRefusalIsAuthFailure: () => true,
    noteV2Authenticated: () => {},
    noteV2HelloRefused: () => {}
  }
}
