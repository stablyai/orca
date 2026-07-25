import { describe, expect, it } from 'vitest'
import { resolveAdvertisedPairingEndpoint } from './pairing-endpoint'

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
    ['2001:db8::0', 'ws://[2001:db8::]:6768'],
    ['[2001:db8::4]:7443', 'ws://[2001:db8::4]:7443'],
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
})
