import { describe, expect, it } from 'vitest'
import { parseHexAddress } from './port-scan-handler'

describe('parseHexAddress', () => {
  it('parses IPv4 localhost (127.0.0.1)', () => {
    // 127.0.0.1 in little-endian hex: 0100007F
    const result = parseHexAddress('0100007F:0BB8')
    expect(result).toEqual({ host: '127.0.0.1', port: 3000 })
  })

  it('parses IPv4 all-interfaces (0.0.0.0)', () => {
    const result = parseHexAddress('00000000:1F90')
    expect(result).toEqual({ host: '0.0.0.0', port: 8080 })
  })

  it('parses port 22 correctly', () => {
    const result = parseHexAddress('00000000:0016')
    expect(result).toEqual({ host: '0.0.0.0', port: 22 })
  })

  it('parses port 443 correctly', () => {
    const result = parseHexAddress('0100007F:01BB')
    expect(result).toEqual({ host: '127.0.0.1', port: 443 })
  })

  it('parses a non-localhost IPv4 address', () => {
    // 192.168.1.100 in little-endian: 6401A8C0
    const result = parseHexAddress('6401A8C0:1388')
    expect(result).toEqual({ host: '192.168.1.100', port: 5000 })
  })

  it('parses IPv6 all-zeros (::)', () => {
    const result = parseHexAddress('00000000000000000000000000000000:1F90')
    expect(result).toEqual({ host: '::', port: 8080 })
  })

  it('parses IPv6 loopback (::1)', () => {
    const result = parseHexAddress('00000000000000000000000001000000:0BB8')
    expect(result).toEqual({ host: '::1', port: 3000 })
  })

  it('returns null for port 0', () => {
    const result = parseHexAddress('0100007F:0000')
    expect(result).toBeNull()
  })

  it('returns null for malformed input', () => {
    expect(parseHexAddress('invalid')).toBeNull()
    expect(parseHexAddress('')).toBeNull()
    expect(parseHexAddress('::::')).toBeNull()
  })

  it('parses high ports correctly', () => {
    // Port 65535 = FFFF
    const result = parseHexAddress('0100007F:FFFF')
    expect(result).toEqual({ host: '127.0.0.1', port: 65535 })
  })

  it('parses port 5432 (postgres)', () => {
    const result = parseHexAddress('0100007F:1538')
    expect(result).toEqual({ host: '127.0.0.1', port: 5432 })
  })

  it('parses port 3306 (mysql)', () => {
    const result = parseHexAddress('00000000:0CEA')
    expect(result).toEqual({ host: '0.0.0.0', port: 3306 })
  })
})
