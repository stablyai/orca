import { describe, expect, it } from 'vitest'
import {
  displayHostEndpoint,
  endpointPort,
  endpointScheme,
  normalizeHostEndpoint
} from './host-endpoint'

describe('displayHostEndpoint', () => {
  it('shows host:port for websocket URLs', () => {
    expect(displayHostEndpoint('ws://192.168.1.10:6768')).toBe('192.168.1.10:6768')
    // Why: URL omits default scheme ports (443 for wss); use a non-default port.
    expect(displayHostEndpoint('wss://desk.example:8443')).toBe('desk.example:8443')
  })

  it('returns the raw string when not a URL', () => {
    expect(displayHostEndpoint('not-a-url')).toBe('not-a-url')
  })

  it('brackets IPv6 hostnames for round-trip safety', () => {
    expect(displayHostEndpoint('ws://[fd7a:115c:a1e0::1]:6768')).toBe('[fd7a:115c:a1e0::1]:6768')
  })
})

describe('endpointPort', () => {
  it('reads the port when present', () => {
    expect(endpointPort('ws://192.168.1.10:6768')).toBe('6768')
  })

  it('returns undefined when the port is omitted', () => {
    expect(endpointPort('ws://192.168.1.10')).toBeUndefined()
  })

  it('preserves scheme-default ports that URL.port hides', () => {
    expect(endpointPort('ws://192.168.1.10:80')).toBe('80')
    expect(endpointPort('wss://desk.example:443')).toBe('443')
  })
})

describe('endpointScheme', () => {
  it('returns wss for a wss:// endpoint', () => {
    expect(endpointScheme('wss://desk.example:8443')).toBe('wss')
  })

  it('returns ws for a ws:// endpoint', () => {
    expect(endpointScheme('ws://192.168.1.10:6768')).toBe('ws')
  })

  it('falls back to ws for a non-URL endpoint', () => {
    expect(endpointScheme('not-a-url')).toBe('ws')
  })
})

describe('normalizeHostEndpoint', () => {
  it('accepts a full ws URL', () => {
    expect(normalizeHostEndpoint('ws://100.64.0.5:6768')).toEqual({
      ok: true,
      endpoint: 'ws://100.64.0.5:6768'
    })
  })

  it('accepts wss and preserves scheme', () => {
    expect(normalizeHostEndpoint('wss://desk.example:8443')).toEqual({
      ok: true,
      endpoint: 'wss://desk.example:8443'
    })
  })

  it('accepts bare host:port', () => {
    expect(normalizeHostEndpoint('192.168.1.10:6768')).toEqual({
      ok: true,
      endpoint: 'ws://192.168.1.10:6768'
    })
  })

  it('defaults missing port to 6768', () => {
    expect(normalizeHostEndpoint('192.168.1.10')).toEqual({
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

  it('rejects empty input', () => {
    expect(normalizeHostEndpoint('   ')).toEqual({
      ok: false,
      error: 'Enter a host address.'
    })
  })

  it('rejects non-websocket schemes', () => {
    expect(normalizeHostEndpoint('http://192.168.1.10:6768')).toEqual({
      ok: false,
      error: 'Use ws:// or wss:// (or host:port).'
    })
  })

  it('rejects explicit invalid ports without falling back', () => {
    for (const input of [
      '192.168.1.10:0',
      '192.168.1.10:99999',
      'ws://192.168.1.10:0',
      'ws://192.168.1.10:99999'
    ]) {
      expect(normalizeHostEndpoint(input, { fallbackPort: '6768' })).toEqual({
        ok: false,
        error: 'Port must be 1–65535.'
      })
    }
  })

  it('rejects bare hosts with path, query, or spaces', () => {
    expect(normalizeHostEndpoint('desk/path')).toEqual({
      ok: false,
      error: 'Not a valid hostname.'
    })
    expect(normalizeHostEndpoint('desk?route')).toEqual({
      ok: false,
      error: 'Not a valid hostname.'
    })
    expect(normalizeHostEndpoint('desk name')).toEqual({
      ok: false,
      error: 'Not a valid hostname.'
    })
  })

  it('rejects scheme URLs with path or query', () => {
    expect(normalizeHostEndpoint('ws://desk.example/path')).toEqual({
      ok: false,
      error: 'Host must not include a path or query.'
    })
    expect(normalizeHostEndpoint('ws://desk.example?route=1')).toEqual({
      ok: false,
      error: 'Host must not include a path or query.'
    })
  })

  it('accepts bracketed IPv6 with port', () => {
    expect(normalizeHostEndpoint('[fd7a:115c:a1e0::1]:6768')).toEqual({
      ok: true,
      endpoint: 'ws://[fd7a:115c:a1e0::1]:6768'
    })
  })

  it('rejects malformed IPv6 that a WebSocket URL cannot parse', () => {
    expect(normalizeHostEndpoint('[1::2::3]:6768')).toEqual({
      ok: false,
      error: 'Not a valid hostname.'
    })
  })

  it('rejects non-canonical numeric IPv4 forms in bare addresses', () => {
    for (const host of ['999.999.999.999', '010.0.0.1', '127.1', '0x7f000001']) {
      expect(normalizeHostEndpoint(`${host}:6768`)).toEqual({
        ok: false,
        error: 'Not a valid hostname.'
      })
    }
  })

  it('rejects non-canonical numeric IPv4 forms before URL normalization', () => {
    for (const host of ['999.999.999.999', '010.0.0.1', '127.1', '0x7f000001']) {
      expect(normalizeHostEndpoint(`ws://${host}:6768`)).toEqual({
        ok: false,
        error: 'Not a valid hostname.'
      })
    }
  })

  it('rejects encoded and trailing-dot numeric IPv4 aliases', () => {
    for (const input of ['ws://127.1.:6768', 'wss://127.1.:6768', 'ws://%31%32%37.1:6768']) {
      expect(normalizeHostEndpoint(input)).toEqual({
        ok: false,
        error: 'Not a valid hostname.'
      })
    }
  })

  it('rejects empty userinfo before URL normalization', () => {
    expect(normalizeHostEndpoint('ws://@127.1:6768')).toEqual({
      ok: false,
      error: 'Not a valid address.'
    })
  })

  it('reports a path or query before validating a numeric hostname alias', () => {
    for (const input of ['ws://127.1/path', 'ws://127.1?route=1']) {
      expect(normalizeHostEndpoint(input)).toEqual({
        ok: false,
        error: 'Host must not include a path or query.'
      })
    }
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

  it('round-trips displayed IPv6 endpoints without port corruption', () => {
    const original = 'ws://[fd7a:115c:a1e0::1]:6768'
    const displayed = displayHostEndpoint(original)
    expect(displayed).toBe('[fd7a:115c:a1e0::1]:6768')
    expect(normalizeHostEndpoint(displayed, { fallbackPort: '6768' })).toEqual({
      ok: true,
      endpoint: original
    })
  })
})
