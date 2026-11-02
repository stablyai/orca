import { describe, expect, it } from 'vitest'
import { displayHostEndpoint } from './host-endpoint'
import { resolveHostEndpointEdit } from './host-endpoint-edit'

describe('resolveHostEndpointEdit', () => {
  it.each([
    ['implicit secure DNS proxy', 'wss://desk.example.com'],
    ['explicit secure default', 'wss://desk.example.com:443'],
    ['explicit secure custom', 'wss://desk.example.com:8443'],
    ['implicit secure IPv6 proxy', 'wss://[2001:db8::1]'],
    ['explicit secure IPv6 default', 'wss://[2001:db8::1]:443'],
    ['implicit LAN websocket', 'ws://desk.local'],
    ['explicit websocket default', 'ws://desk.local:80'],
    ['explicit websocket custom', 'ws://desk.local:6768'],
    ['secure path-routed proxy', 'wss://desk.example.com/orca'],
    ['secure query-routed proxy', 'wss://desk.example.com/orca?route=runtime'],
    ['legacy bare hostname', 'desk.local'],
    ['legacy bare host and port', 'desk.local:7777'],
    ['legacy unparsable endpoint', 'not-a-url']
  ])('preserves an untouched %s endpoint', (_label, stored) => {
    const edit = resolveHostEndpointEdit(stored, displayHostEndpoint(stored))

    expect(edit).toEqual({ kind: 'unchanged', endpoint: stored })
  })

  it.each([
    ['wss://old.example.com', 'new.example.com', 'wss://new.example.com:443'],
    ['wss://old.example.com:8443', 'new.example.com', 'wss://new.example.com:8443'],
    ['ws://old.local', 'new.local', 'ws://new.local:6768'],
    ['ws://old.local:80', 'new.local', 'ws://new.local:80'],
    ['wss://[2001:db8::1]', '[2001:db8::2]', 'wss://[2001:db8::2]:443']
  ])('uses the current endpoint semantics for an address edit', (stored, input, expected) => {
    const edit = resolveHostEndpointEdit(stored, input)

    expect(edit).toEqual({ kind: 'changed', endpoint: expected })
  })

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

  it('discriminates invalid input without a candidate endpoint', () => {
    expect(
      resolveHostEndpointEdit('wss://desk.example.com/orca', 'https://desk.example.com')
    ).toEqual({
      kind: 'invalid',
      error: 'Use ws:// or wss:// (or host:port).'
    })
  })
})
