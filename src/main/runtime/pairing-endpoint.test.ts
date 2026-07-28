import { describe, expect, it } from 'vitest'
import { resolveAdvertisedPairingEndpoint } from './pairing-endpoint'
import { PAIRING_OFFER_VERSION, PairingOfferSchema } from '../../shared/mobile-relay-pairing-offer'
import { PAIRING_ENDPOINT_MAX_CHARACTERS } from '../../shared/mobile-pairing-protocol-limits'
import { parseManualNetworkAddress } from '../../shared/network/manual-address'

describe('resolveAdvertisedPairingEndpoint', () => {
  const bound = 'ws://0.0.0.0:6768'

  it('uses loopback by default without advertising the wildcard bind address', () => {
    expect(resolveAdvertisedPairingEndpoint(bound, null)).toEqual({
      ok: true,
      endpoint: 'ws://127.0.0.1:6768'
    })
  })

  it.each([
    ['100.64.1.20', 'ws://100.64.1.20:6768'],
    ['host.tailnet.ts.net', 'ws://host.tailnet.ts.net:6768'],
    ['proxy.example.test:80', 'ws://proxy.example.test'],
    ['lan-host:7443', 'ws://lan-host:7443'],
    ['::1', 'ws://[::1]:6768'],
    ['0:0:0:0:0:0:0:1', 'ws://[::1]:6768'],
    ['2001:db8::0', 'ws://[2001:db8::]:6768'],
    ['[2001:db8::4]:7443', 'ws://[2001:db8::4]:7443'],
    ['[0:0:0:0:0:0:0:1]:7443', 'ws://[::1]:7443'],
    ['http://proxy.example.test/orca', 'ws://proxy.example.test/orca'],
    ['https://proxy.example.test/orca', 'wss://proxy.example.test/orca'],
    [
      'wss://proxy.example.test:8443/orca?route=runtime',
      'wss://proxy.example.test:8443/orca?route=runtime'
    ]
  ])('normalizes %s', (input, expected) => {
    expect(resolveAdvertisedPairingEndpoint(bound, input)).toEqual({
      ok: true,
      endpoint: expected
    })
  })

  it.each([
    '*',
    '0.0.0.0',
    '::',
    '0:0:0:0:0:0:0:0',
    '[0:0:0:0:0:0:0:0]:8080',
    'ws://[0:0:0:0:0:0:0:0]:8080',
    '::ffff:0.0.0.0',
    '[::ffff:0.0.0.0]:8080',
    'ws://[::ffff:0.0.0.0]:8080',
    'ftp://proxy.example.test',
    'ws://user:secret@proxy.example.test',
    'ws://proxy.example.test/#fragment',
    'host.example.test/path',
    'host.example.test:0',
    'host.example.test:',
    '[::1]:',
    'host.example.test:65536'
  ])('rejects unusable advertised endpoint %s', (input) => {
    expect(resolveAdvertisedPairingEndpoint(bound, input)).toMatchObject({
      ok: false,
      reason: 'invalid_advertised_endpoint'
    })
  })

  it.each([
    ['::ffff:192.168.1.24', 'ws://[::ffff:c0a8:118]:6768'],
    ['[::ffff:192.168.1.24]:8080', 'ws://[::ffff:c0a8:118]:8080'],
    ['2001:db8::24', 'ws://[2001:db8::24]:6768']
  ])('accepts reachable mapped/native IPv6 control %s', (input, endpoint) => {
    expect(resolveAdvertisedPairingEndpoint(bound, input)).toEqual({ ok: true, endpoint })
  })

  it.each([
    ['ws://host.example.test.', true],
    ['ws://0x7f.1:6768', true],
    ['\u0000ws://host.example.test', false],
    ['ws://host.example.test/path\u0001', false]
  ])('keeps full-URL renderer/main acceptance aligned for %j', (input, accepted) => {
    expect(parseManualNetworkAddress(input).ok).toBe(accepted)
    expect(resolveAdvertisedPairingEndpoint(bound, input).ok).toBe(accepted)
  })

  it('matches the pairing-offer endpoint length boundary', () => {
    const prefix = 'wss://example.test/'
    const atLimit = `${prefix}${'a'.repeat(PAIRING_ENDPOINT_MAX_CHARACTERS - prefix.length)}`
    const aboveLimit = `${atLimit}a`
    const offer = (endpoint: string) => ({
      v: PAIRING_OFFER_VERSION,
      endpoint,
      deviceToken: 'token',
      publicKeyB64: 'key'
    })

    expect(resolveAdvertisedPairingEndpoint(bound, atLimit)).toEqual({
      ok: true,
      endpoint: atLimit
    })
    expect(PairingOfferSchema.safeParse(offer(atLimit)).success).toBe(true)
    expect(resolveAdvertisedPairingEndpoint(bound, aboveLimit).ok).toBe(false)
    expect(PairingOfferSchema.safeParse(offer(aboveLimit)).success).toBe(false)
  })
})
