import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { forwardedClientIp, loadIpCountryTable, parseIpCountryTable, requestCountry } from './ip-country.js'

// Documentation ranges (RFC 5737, RFC 3849) stand in for real allocations.
const TABLE = [
  '0.0.0.0,0.255.255.255,ZZ',
  '192.0.2.0,192.0.2.127,CN',
  '192.0.2.128,192.0.2.255,HK',
  '198.51.100.0,198.51.100.255,US',
  '2001:db8::,2001:db8:0:ffff:ffff:ffff:ffff:ffff,CN',
  '2001:db8:1::,2001:db8:1:ffff:ffff:ffff:ffff:ffff,JP',
  'not,a,row',
  ''
].join('\n')

describe('forwardedClientIp', () => {
  it('takes the last hop: the peer Cloud Run appended, never an entry the client sent', () => {
    expect(forwardedClientIp('192.0.2.1')).toBe('192.0.2.1')
    expect(forwardedClientIp('198.51.100.7, 192.0.2.1')).toBe('192.0.2.1')
    expect(forwardedClientIp(' 10.0.0.1 ,198.51.100.7,2001:db8::1 ')).toBe('2001:db8::1')
    expect(forwardedClientIp('192.0.2.1,')).toBe('192.0.2.1')
  })

  it('skips trusted proxy hops of ours appended after the client', () => {
    expect(forwardedClientIp('198.51.100.7, 192.0.2.1, 203.0.113.9', 1)).toBe('192.0.2.1')
    expect(forwardedClientIp('192.0.2.1', 1)).toBeUndefined()
  })

  it('is undefined without a usable hop', () => {
    expect(forwardedClientIp(undefined)).toBeUndefined()
    expect(forwardedClientIp('')).toBeUndefined()
    expect(forwardedClientIp(' , ')).toBeUndefined()
    expect(forwardedClientIp('192.0.2.1, unknown')).toBeUndefined()
    expect(forwardedClientIp('192.0.2.1:443')).toBeUndefined()
  })
})

describe('IP country table', () => {
  const table = parseIpCountryTable(TABLE)

  it('finds the range of IPv4, IPv4-mapped and IPv6 addresses', () => {
    expect(table.country('192.0.2.0')).toBe('CN')
    expect(table.country('192.0.2.127')).toBe('CN')
    expect(table.country('192.0.2.128')).toBe('HK')
    expect(table.country('198.51.100.200')).toBe('US')
    expect(table.country('::ffff:192.0.2.200')).toBe('HK')
    // The hex spelling of the same mapped addresses, and a fully written-out one.
    expect(table.country('::ffff:c000:2c8')).toBe('HK')
    expect(table.country('::FFFF:C000:0201')).toBe('CN')
    expect(table.country('0:0:0:0:0:ffff:c633:6401')).toBe('US')
    expect(table.country('2001:db8::192.0.2.1')).toBe('CN')
    expect(table.country('2001:db8::1')).toBe('CN')
    expect(table.country('2001:db8:0:ffff::1')).toBe('CN')
    expect(table.country('2001:db8:1:2::')).toBe('JP')
    expect(table.country('2001:DB8:1::abcd')).toBe('JP')
  })

  it('answers undefined for gaps, reserved codes and non-addresses', () => {
    expect(table.country('0.1.2.3')).toBeUndefined()
    expect(table.country('203.0.113.1')).toBeUndefined()
    expect(table.country('1.1.1.1')).toBeUndefined()
    expect(table.country('2001:db8:2::1')).toBeUndefined()
    expect(table.country('::1')).toBeUndefined()
    expect(table.country('nonsense')).toBeUndefined()
  })

  it('loads plain and gzipped files and refuses an empty table', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ip-country-'))
    writeFileSync(join(directory, 'table.csv'), TABLE)
    writeFileSync(join(directory, 'table.csv.gz'), gzipSync(TABLE))
    writeFileSync(join(directory, 'empty.csv'), 'a,b,c\n')
    expect(loadIpCountryTable(join(directory, 'table.csv')).country('192.0.2.200')).toBe('HK')
    expect(loadIpCountryTable(join(directory, 'table.csv.gz')).country('192.0.2.1')).toBe('CN')
    expect(() => loadIpCountryTable(join(directory, 'empty.csv'))).toThrow('ip_country_table_empty')
    expect(() => loadIpCountryTable(join(directory, 'missing.csv'))).toThrow()
  })
})

describe('requestCountry', () => {
  const table = parseIpCountryTable(TABLE)

  it('is the last hop’s country, or null when unknown', () => {
    expect(requestCountry(table, '198.51.100.7, 192.0.2.1')).toBe('CN')
    expect(requestCountry(table, '192.0.2.1, 198.51.100.7')).toBe('US')
    expect(requestCountry(table, '203.0.113.1')).toBeNull()
    expect(requestCountry(table, undefined)).toBeNull()
    expect(requestCountry(undefined, '192.0.2.1')).toBeNull()
  })
})
