import { describe, expect, it } from 'vitest'
import {
  AllowedClientRangeError,
  createAllowedClientList,
  isClientAddressAllowed,
  normalizeClientAddress,
  parseAllowedClientRanges
} from './ws-client-address-policy'

describe('parseAllowedClientRanges', () => {
  it('splits a comma-separated list of addresses and ranges', () => {
    expect(parseAllowedClientRanges(' 203.0.113.7, 100.64.0.0/10 ,fd7a:115c:a1e0::/48')).toEqual([
      '203.0.113.7',
      '100.64.0.0/10',
      'fd7a:115c:a1e0::/48'
    ])
  })

  it.each(['', ' , ', 'example.com', '10.0.0.0/33', '10.0.0.0/8/1', '::/129', '10.0.0.0/x'])(
    'refuses %j',
    (raw) => {
      expect(() => parseAllowedClientRanges(raw)).toThrow(AllowedClientRangeError)
    }
  )
})

describe('isClientAddressAllowed', () => {
  const list = createAllowedClientList(['203.0.113.7', '100.64.0.0/10', 'fd7a:115c:a1e0::/48'])

  it('admits listed addresses and members of listed ranges', () => {
    expect(isClientAddressAllowed(list, '203.0.113.7')).toBe(true)
    expect(isClientAddressAllowed(list, '100.101.102.103')).toBe(true)
    expect(isClientAddressAllowed(list, 'fd7a:115c:a1e0:ab12::1')).toBe(true)
  })

  it('matches IPv4 peers that a dual-stack listener reports as mapped IPv6', () => {
    expect(isClientAddressAllowed(list, '::ffff:100.64.0.1')).toBe(true)
    expect(isClientAddressAllowed(list, '::ffff:198.51.100.1')).toBe(false)
  })

  it('refuses everything else, including a missing address', () => {
    expect(isClientAddressAllowed(list, '198.51.100.1')).toBe(false)
    expect(isClientAddressAllowed(list, '2001:db8::1')).toBe(false)
    expect(isClientAddressAllowed(list, undefined)).toBe(false)
  })

  it('always admits loopback so SSH port-forwards keep working', () => {
    expect(isClientAddressAllowed(list, '127.0.0.1')).toBe(true)
    expect(isClientAddressAllowed(list, '::1')).toBe(true)
    expect(isClientAddressAllowed(list, '::ffff:127.0.0.1')).toBe(true)
  })
})

describe('normalizeClientAddress', () => {
  it('unmaps IPv4-mapped IPv6 and rejects non-addresses', () => {
    expect(normalizeClientAddress('::FFFF:10.0.0.1')).toBe('10.0.0.1')
    expect(normalizeClientAddress('fe80::1')).toBe('fe80::1')
    expect(normalizeClientAddress('not-an-ip')).toBeNull()
  })
})
