import { describe, expect, it } from 'vitest'
import { displayHostEndpoint, normalizeHostEndpoint } from './host-endpoint'

describe('normalizeHostEndpoint', () => {
  it('accepts bare host:port', () => {
    expect(normalizeHostEndpoint('192.168.1.10:6768')).toEqual({
      ok: true,
      endpoint: 'ws://192.168.1.10:6768'
    })
  })

  it('uses fallbackPort when the user omits the port', () => {
    expect(normalizeHostEndpoint('mac-mini.local', { fallbackPort: '7777' })).toEqual({
      ok: true,
      endpoint: 'ws://mac-mini.local:7777'
    })
  })

  it('fills missing port on scheme URLs from fallbackPort', () => {
    expect(normalizeHostEndpoint('ws://192.168.1.10', { fallbackPort: '9000' })).toEqual({
      ok: true,
      endpoint: 'ws://192.168.1.10:9000'
    })
  })

  it('preserves explicit ws :80 and wss :443 instead of rewriting to fallback', () => {
    expect(normalizeHostEndpoint('ws://192.168.1.10:80', { fallbackPort: '6768' })).toEqual({
      ok: true,
      endpoint: 'ws://192.168.1.10:80'
    })
    expect(normalizeHostEndpoint('wss://desk.example:443', { fallbackPort: '6768' })).toEqual({
      ok: true,
      endpoint: 'wss://desk.example:443'
    })
    expect(displayHostEndpoint('ws://192.168.1.10:80')).toBe('192.168.1.10:80')
    expect(displayHostEndpoint('wss://desk.example:443')).toBe('desk.example:443')
  })

  it('trims whitespace', () => {
    expect(normalizeHostEndpoint('  10.0.0.2:6768  ')).toEqual({
      ok: true,
      endpoint: 'ws://10.0.0.2:6768'
    })
  })

  it('accepts bracketed IPv6 with port', () => {
    expect(normalizeHostEndpoint('[fd7a:115c:a1e0::1]:6768')).toEqual({
      ok: true,
      endpoint: 'ws://[fd7a:115c:a1e0::1]:6768'
    })
  })

  it('keeps ordinary DNS names that contain numeric labels', () => {
    expect(normalizeHostEndpoint('desk123.local:6768')).toEqual({
      ok: true,
      endpoint: 'ws://desk123.local:6768'
    })
    expect(normalizeHostEndpoint('ws://123.example:6768')).toEqual({
      ok: true,
      endpoint: 'ws://123.example:6768'
    })
  })

  it('preserves wss when re-normalizing bare host:port via fallbackScheme', () => {
    expect(
      normalizeHostEndpoint('desk.example:8443', { fallbackScheme: 'wss', fallbackPort: '8443' })
    ).toEqual({
      ok: true,
      endpoint: 'wss://desk.example:8443'
    })
  })
})
