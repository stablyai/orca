import { describe, expect, it } from 'vitest'
import { displayHostEndpoint, normalizeHostEndpoint } from './host-endpoint'

describe('normalizeHostEndpoint', () => {
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

  it('preserves wss when re-normalizing bare host:port via fallbackScheme', () => {
    expect(
      normalizeHostEndpoint('desk.example:8443', { fallbackScheme: 'wss', fallbackPort: '8443' })
    ).toEqual({
      ok: true,
      endpoint: 'wss://desk.example:8443'
    })
  })
})
