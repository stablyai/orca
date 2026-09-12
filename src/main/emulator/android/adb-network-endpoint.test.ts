import { describe, expect, it } from 'vitest'
import { isAdbNetworkSerial, parseAdbNetworkEndpoint } from './adb-network-endpoint'

describe('parseAdbNetworkEndpoint', () => {
  it('accepts a hostname and port', () => {
    expect(parseAdbNetworkEndpoint('cloud.internal:5555')).toEqual({
      host: 'cloud.internal',
      port: 5555
    })
  })

  it('accepts an IPv4 literal and port', () => {
    expect(parseAdbNetworkEndpoint('127.0.0.1:5555')).toEqual({
      host: '127.0.0.1',
      port: 5555
    })
  })

  it('rejects a dotted-quad host with an out-of-range octet', () => {
    // Dotted-quad shape is treated as an IPv4 literal, not a fallback hostname,
    // so an octet > 255 must not sneak through as a "valid hostname".
    expect(parseAdbNetworkEndpoint('999.1.1.1:5555')).toMatchObject({ error: 'invalid' })
  })

  it('accepts the boundary ports 1 and 65535', () => {
    expect(parseAdbNetworkEndpoint('h:1')).toEqual({ host: 'h', port: 1 })
    expect(parseAdbNetworkEndpoint('h:65535')).toEqual({ host: 'h', port: 65535 })
  })

  it('rejects an empty address', () => {
    expect(parseAdbNetworkEndpoint('')).toMatchObject({ error: 'invalid' })
  })

  it('rejects a missing port', () => {
    expect(parseAdbNetworkEndpoint('host')).toMatchObject({ error: 'invalid' })
    expect(parseAdbNetworkEndpoint('host:')).toMatchObject({ error: 'invalid' })
  })

  it('rejects a non-numeric port', () => {
    expect(parseAdbNetworkEndpoint('host:abc')).toMatchObject({ error: 'invalid' })
  })

  it('rejects port 0, out-of-range, and signed ports', () => {
    expect(parseAdbNetworkEndpoint('h:0')).toMatchObject({ error: 'invalid' })
    expect(parseAdbNetworkEndpoint('h:65536')).toMatchObject({ error: 'invalid' })
    expect(parseAdbNetworkEndpoint('h:-1')).toMatchObject({ error: 'invalid' })
    expect(parseAdbNetworkEndpoint('h:+22')).toMatchObject({ error: 'invalid' })
  })

  it('rejects URL schemes', () => {
    expect(parseAdbNetworkEndpoint('http://h:1')).toMatchObject({ error: 'invalid' })
    expect(parseAdbNetworkEndpoint('adb://h:1')).toMatchObject({ error: 'invalid' })
  })

  it('rejects a path component', () => {
    expect(parseAdbNetworkEndpoint('h:1/x')).toMatchObject({ error: 'invalid' })
  })

  it('rejects credentials', () => {
    expect(parseAdbNetworkEndpoint('user@h:1')).toMatchObject({ error: 'invalid' })
  })

  it('rejects a space inside the address', () => {
    expect(parseAdbNetworkEndpoint('h :1')).toMatchObject({ error: 'invalid' })
  })

  it('rejects tab and control characters inside the address', () => {
    const tabbed = `${['h', '1'].join(String.fromCharCode(9))}:1`
    const controlled = `${['h', '1'].join(String.fromCharCode(1))}:1`
    expect(parseAdbNetworkEndpoint(tabbed)).toMatchObject({ error: 'invalid' })
    expect(parseAdbNetworkEndpoint(controlled)).toMatchObject({ error: 'invalid' })
  })

  it('classifies bracketed IPv6 as unsupported, not invalid', () => {
    const result = parseAdbNetworkEndpoint('[::1]:5555')
    expect(result).toMatchObject({ error: 'unsupported_ipv6' })
    expect((result as { message: string }).message).toMatch(/IPv6/)
  })
})

describe('isAdbNetworkSerial', () => {
  it('recognizes host:port and IPv4:port serials', () => {
    expect(isAdbNetworkSerial('cloud.internal:5555')).toBe(true)
    expect(isAdbNetworkSerial('127.0.0.1:5555')).toBe(true)
  })

  it('rejects emulator serials and USB serials', () => {
    expect(isAdbNetworkSerial('emulator-5554')).toBe(false)
    expect(isAdbNetworkSerial('R58N123ABC')).toBe(false)
  })

  it('rejects bracketed IPv6 (unsupported, not a real adb serial shape)', () => {
    expect(isAdbNetworkSerial('[::1]:5555')).toBe(false)
  })
})
