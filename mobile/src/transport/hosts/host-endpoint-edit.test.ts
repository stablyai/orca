import { describe, expect, it } from 'vitest'

import { resolveHostEndpointEdit } from './host-endpoint-edit'

describe('resolveHostEndpointEdit', () => {
  it.each([
    ['ws://192.168.1.10:6768', 'wss://tunnel.example.com', 'wss://tunnel.example.com:443'],
    ['wss://old.example.com:8443', '  WSS://tunnel.example.com  ', 'wss://tunnel.example.com:443'],
    ['ws://192.168.1.10:6768', 'wss://[2001:db8::2]', 'wss://[2001:db8::2]:443'],
    ['ws://192.168.1.10:6768', 'wss://tunnel.example.com:9443', 'wss://tunnel.example.com:9443'],
    ['ws://192.168.1.10:6768', 'tunnel.example.com', 'ws://tunnel.example.com:6768'],
    [
      'wss://old.example.com:8443/orca?route=runtime',
      'wss://tunnel.example.com',
      'wss://tunnel.example.com:443/orca?route=runtime'
    ]
  ])(
    'resolves explicit secure URLs independently of the saved port (%s → %s)',
    (stored, input, expected) => {
      expect(resolveHostEndpointEdit(stored, input)).toEqual({
        kind: 'changed',
        endpoint: expected
      })
    }
  )

  it.each([
    ['surrounding whitespace', '  desk.example.com  '],
    ['hostname case', 'DESK.EXAMPLE.COM'],
    ['explicit default port', 'desk.example.com:443'],
    ['percent-encoded hostname', 'wss://%64esk.example.com:443']
  ])('preserves routed endpoint bytes for equivalent %s', (_label, input) => {
    const stored = 'wss://Desk.Example.com/%6Fruntime?route=%72ed'

    expect(resolveHostEndpointEdit(stored, input)).toEqual({
      kind: 'unchanged',
      endpoint: stored
    })
  })

  it('preserves the hidden route when the authority changes', () => {
    expect(
      resolveHostEndpointEdit('wss://old.example.com/%6Fruntime?route=%72ed', 'new.example.com')
    ).toEqual({
      kind: 'changed',
      endpoint: 'wss://new.example.com:443/%6Fruntime?route=%72ed'
    })
  })
})
