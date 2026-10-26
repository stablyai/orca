import { describe, expect, it } from 'vitest'
import {
  cacheEndpointAuthSnapshot,
  clearEndpointAuthHeadersCache,
  describeEndpointAuthHeadersForLog,
  edgeAuthHeadersForEndpoint,
  normalizeEndpointAuthHeaders,
  peekEndpointAuthHeaders
} from './endpoint-auth-headers'

describe('normalizeEndpointAuthHeaders', () => {
  it('accepts valid rows and trims whitespace', () => {
    expect(
      normalizeEndpointAuthHeaders([
        { name: '  CF-Access-Client-Id  ', value: '  abc123  ' },
        { name: 'X-Custom-Auth', value: 's3cret!' }
      ])
    ).toEqual({
      ok: true,
      headers: { 'CF-Access-Client-Id': 'abc123', 'X-Custom-Auth': 's3cret!' }
    })
  })

  it('drops fully blank rows', () => {
    expect(
      normalizeEndpointAuthHeaders([
        { name: '', value: '' },
        { name: '  ', value: '' }
      ])
    ).toEqual({ ok: true, headers: {} })
  })

  it('rejects non-list input and non-pair rows', () => {
    expect(normalizeEndpointAuthHeaders(null)).toEqual({
      ok: false,
      error: 'Headers must be a list.'
    })
    expect(normalizeEndpointAuthHeaders(['nope'])).toEqual({
      ok: false,
      error: 'Each header must be a name/value pair.'
    })
  })

  it('rejects invalid names and values', () => {
    expect(normalizeEndpointAuthHeaders([{ name: 'has space', value: 'v' }]).ok).toBe(false)
    expect(normalizeEndpointAuthHeaders([{ name: 'X-Ok', value: '' }]).ok).toBe(false)
    expect(normalizeEndpointAuthHeaders([{ name: 'X-Ok', value: 'has\nnewline' }]).ok).toBe(false)
    expect(normalizeEndpointAuthHeaders([{ name: 'X-Ok', value: 'x'.repeat(1025) }]).ok).toBe(false)
  })

  it('rejects non-ASCII secrets without including their value in the error', () => {
    const result = normalizeEndpointAuthHeaders([{ name: 'X-Token', value: 'secret-é' }])
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('secret-é')
  })

  it('dedupes case-insensitive names with last value winning', () => {
    expect(
      normalizeEndpointAuthHeaders([
        { name: 'X-Token', value: 'first' },
        { name: 'x-token', value: 'second' }
      ])
    ).toEqual({ ok: true, headers: { 'x-token': 'second' } })
  })

  it('rejects more than eight headers', () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ name: `X-H-${i}`, value: 'v' }))
    expect(normalizeEndpointAuthHeaders(rows).ok).toBe(false)
  })

  it('preserves valid header names that match Object prototype properties', () => {
    const result = normalizeEndpointAuthHeaders([{ name: '__proto__', value: 'token' }])
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('Valid header was rejected')
    }
    expect(Object.hasOwn(result.headers, '__proto__')).toBe(true)
    expect(Object.entries(result.headers)).toEqual([['__proto__', 'token']])
  })
})

describe('describeEndpointAuthHeadersForLog', () => {
  it('names names only, never values', () => {
    const description = describeEndpointAuthHeadersForLog({
      'CF-Access-Client-Id': 'super-secret-id',
      'CF-Access-Client-Secret': 'super-secret-value'
    })
    expect(description).toContain('CF-Access-Client-Id')
    expect(description).toContain('CF-Access-Client-Secret')
    expect(description).not.toContain('super-secret-id')
    expect(description).not.toContain('super-secret-value')
  })

  it('reports empty input', () => {
    expect(describeEndpointAuthHeadersForLog(null)).toBe('no edge-auth headers')
    expect(describeEndpointAuthHeadersForLog({})).toBe('no edge-auth headers')
  })
})

describe('edgeAuthHeadersForEndpoint', () => {
  it('passes headers only on encrypted transports', () => {
    const headers = { 'CF-Access-Client-Id': 'id' }
    expect(edgeAuthHeadersForEndpoint('wss://tunnel.example/x', headers)).toEqual(headers)
    expect(edgeAuthHeadersForEndpoint('ws://192.168.1.10:6768', headers)).toBeNull()
    expect(edgeAuthHeadersForEndpoint('wss://tunnel.example/x', null)).toBeNull()
    expect(edgeAuthHeadersForEndpoint('wss://tunnel.example/x', {})).toBeNull()
  })
})

describe('endpoint auth snapshot cache', () => {
  it('peeks what was cached and clears it', () => {
    cacheEndpointAuthSnapshot('host-9', { 'X-A': 'b' }, 'wss://orca.example.com')
    expect(peekEndpointAuthHeaders('host-9', 'wss://orca.example.com')).toEqual({ 'X-A': 'b' })
    expect(peekEndpointAuthHeaders('unknown-host', 'wss://orca.example.com')).toBeNull()
    clearEndpointAuthHeadersCache('host-9')
    expect(peekEndpointAuthHeaders('host-9', 'wss://orca.example.com')).toBeNull()
  })

  it('binds snapshots to the secure origin, ignoring path and default port spelling', () => {
    cacheEndpointAuthSnapshot('host-9', { 'X-Token': 'secret' }, 'wss://orca.example.com/path')
    expect(peekEndpointAuthHeaders('host-9', 'wss://orca.example.com:443/other')).toEqual({
      'X-Token': 'secret'
    })
    expect(peekEndpointAuthHeaders('host-9', 'wss://other.example.com')).toBeNull()
    expect(peekEndpointAuthHeaders('host-9', 'wss://orca.example.com:8443')).toBeNull()
    expect(peekEndpointAuthHeaders('host-9', 'ws://orca.example.com')).toBeNull()
    clearEndpointAuthHeadersCache('host-9')
  })

  it('treats empty snapshots as absent', () => {
    cacheEndpointAuthSnapshot('host-9', {}, 'wss://orca.example.com')
    expect(peekEndpointAuthHeaders('host-9', 'wss://orca.example.com')).toBeNull()
  })
})
