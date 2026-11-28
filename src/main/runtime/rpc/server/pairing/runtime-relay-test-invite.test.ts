import { afterEach, expect, it, vi } from 'vitest'
import {
  encodePairingOffer,
  parsePairingCode
} from '../../../../../shared/remote-runtime/pairing/pairing'
import type { MobileRelayPairingProvider } from '../runtime-rpc-pairing-types'
import { withTestRelayInvite } from './runtime-relay-test-invite'

// Offers carry invites that expire within 10 minutes of now: pin now.
const NOW = 1_800_000_000_000
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

const offer = {
  deviceId: 'device-1',
  pairingUrl: encodePairingOffer({
    v: 2,
    endpoint: 'ws://127.0.0.1:6768',
    publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
    deviceToken: 'token',
    pairedDeviceId: 'device-1',
    scope: 'runtime'
  })
}
const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.test',
  cellUrl: 'https://cell.test',
  assignmentEpoch: 1,
  relayHostId: 'H'.repeat(16),
  inviteToken: 'I'.repeat(43),
  inviteExpiresAt: NOW + 5 * 60_000,
  e2eeFraming: 2 as const
}
const binding = {
  relayHostId: 'H'.repeat(16),
  relayDeviceId: 'device-1',
  ownerIdentityKey: 'owner'
}

function host(createPairingRelay: MobileRelayPairingProvider['createPairingRelay'], bound = true) {
  const provider: Pick<MobileRelayPairingProvider, 'createPairingRelay'> = { createPairingRelay }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the invite reads only createPairingRelay
    provider: () => Promise.resolve(provider as MobileRelayPairingProvider),
    bind: vi.fn(() => Promise.resolve(bound)),
    retain: vi.fn()
  }
}

it('leaves the offer as is unless the test pairing is on', async () => {
  const mint = vi.fn(() => Promise.resolve({ relay, binding }))
  expect(await withTestRelayInvite(offer, host(mint))).toBe(offer)
  expect(mint).not.toHaveBeenCalled()
})

it('adds a bound Relay invite, and says so when minting or binding it fails', async () => {
  vi.stubEnv('ORCA_TEST_RUNTIME_RELAY_PAIRING', '1')
  vi.useFakeTimers({ now: NOW })
  const added = await withTestRelayInvite(
    offer,
    host(() => Promise.resolve({ relay, binding }))
  )
  expect('pairingUrl' in added && parsePairingCode(added.pairingUrl)?.relay?.relayHostId).toBe(
    relay.relayHostId
  )

  const failedMint = await withTestRelayInvite(
    offer,
    host(() => Promise.reject(new Error('down')))
  )
  expect(failedMint).toMatchObject({ available: false, reason: 'relay_mint_failed' })

  const unbound = host(() => Promise.resolve({ relay, binding }), false)
  expect(await withTestRelayInvite(offer, unbound)).toMatchObject({
    available: false,
    reason: 'relay_mint_failed'
  })
  // A binding Relay already holds but the host could not store is kept for cleanup.
  expect(unbound.retain).toHaveBeenCalledWith('device-1', binding)
})
