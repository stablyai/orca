import { expect, it } from 'vitest'
import contractJson from '../../../shared/remote-runtime/orcad-distribution/local-build-compatibility-contract.json'
import { LOCAL_BUILD_COMPATIBILITY_CONTRACT } from '../../../shared/remote-runtime/orcad-distribution/local-build-compatibility-contract'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS, PROTOCOL_VERSION } from './daemon-protocol-version'
import {
  PROVIDER_RELAY_CAPABILITIES_BY_PROTOCOL,
  providerRelayCapabilities
} from './daemon-provider-relay-protocol'

// Why: an app adopts a running daemon of its own protocol even from an older bundle. Add a row
// with a PROTOCOL_VERSION bump; never edit a shipped one, or that daemon silently lacks it.
const SHIPPED: Record<number, string[]> = {
  63: ['providerRelay'],
  64: ['providerRelay', 'providerRelayKeep', 'providerRelayAcks']
}

it('a relay capability ships only with a daemon protocol bump', () => {
  const newest = Math.max(...Object.keys(SHIPPED).map(Number))
  expect(PROVIDER_RELAY_CAPABILITIES_BY_PROTOCOL).toEqual(SHIPPED)
  expect(newest).toBeLessThanOrEqual(PROTOCOL_VERSION)
  expect(providerRelayCapabilities(PROTOCOL_VERSION)).toEqual(SHIPPED[newest])
  expect(providerRelayCapabilities(63)).toEqual(SHIPPED[63])
  expect(providerRelayCapabilities(62)).toEqual([])
})

// Packaging says hello to the built daemon with the contract's version, which must match its own.
it('the build compatibility contract follows the daemon protocol', () => {
  const attachable = [...PREVIOUS_DAEMON_PROTOCOL_VERSIONS, PROTOCOL_VERSION]
  for (const contract of [LOCAL_BUILD_COMPATIBILITY_CONTRACT, contractJson]) {
    expect(contract.daemonProtocolVersion).toBe(PROTOCOL_VERSION)
    expect(contract.attachableDaemonProtocolVersions).toEqual(attachable)
  }
})
