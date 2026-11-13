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

describe('IP country table input', () => {
  it('reads quoted, padded, lower-case and CRLF rows, and ignores columns past the code', () => {
    const table = parseIpCountryTable(
      '"192.0.2.0","192.0.2.127","cn"\r\n 198.51.100.0 , 198.51.100.255 ,us,Extra,Columns\r\n'
    )
    expect(table.country('192.0.2.1')).toBe('CN')
    expect(table.country('198.51.100.9')).toBe('US')
  })

  it('skips rows without three fields, a two-letter code or a single family', () => {
    const table = parseIpCountryTable(
      [
        '192.0.2.0,192.0.2.255',
        '192.0.2.0,,CN',
        '192.0.2.0,2001:db8::,CN',
        '198.51.100.0,198.51.100.255,USA',
        '203.0.113.0,203.0.113.255,JP'
      ].join('\n')
    )
    expect(table.country('192.0.2.1')).toBeUndefined()
    expect(table.country('198.51.100.1')).toBeUndefined()
    expect(table.country('203.0.113.1')).toBe('JP')
  })

  it('orders an unsorted table, and of two ranges with one start the later row wins', () => {
    const table = parseIpCountryTable(
      [
        '2001:db8:1::,2001:db8:1:ffff:ffff:ffff:ffff:ffff,JP',
        '198.51.100.0,198.51.100.255,US',
        '192.0.2.0,192.0.2.255,CN',
        '2001:db8::,2001:db8:0:ffff:ffff:ffff:ffff:ffff,CN',
        '192.0.2.0,192.0.2.127,HK'
      ].join('\n')
    )
    expect(table.country('192.0.2.1')).toBe('HK')
    expect(table.country('192.0.2.200')).toBeUndefined()
    expect(table.country('198.51.100.1')).toBe('US')
    expect(table.country('2001:db8::1')).toBe('CN')
    expect(table.country('2001:db8:1::1')).toBe('JP')
  })

  it('answers a release-sized table in both families, sorted or not, from a gzipped file', () => {
    // 2^18 IPv4 ranges of 256 addresses from 10.0.0.0 and as many IPv6 /48s from 2001::, each
    // range's code a function of its index; the second file lists the same rows scrambled.
    const size = 1 << 18
    const codeOf = (index: number) =>
      String.fromCharCode(65 + (index % 26), 65 + (Math.floor(index / 26) % 26))
    // A /48 per index: 2001:<high 16 bits>:<low 16 bits>::/48.
    const v6Prefix = (index: number) =>
      `2001:${(index >>> 16).toString(16)}:${(index & 0xffff).toString(16)}`
    const v4 = (value: number) =>
      [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.')
    const rows: string[] = []
    for (let index = 0; index < size; index += 1) {
      const base = 0x0a00_0000 + index * 256
      rows.push(`${v4(base)},${v4(base + 255)},${codeOf(index)}`)
      const prefix = v6Prefix(index)
      rows.push(`${prefix}::,${prefix}:ffff:ffff:ffff:ffff:ffff,${codeOf(index + 7)}`)
    }
    const scrambled = rows.map((_, at) => rows[(at * 7_919) % rows.length]!)
    const directory = mkdtempSync(join(tmpdir(), 'ip-country-large-'))
    const files = [
      ['sorted', rows],
      ['scrambled', scrambled]
    ] as const
    for (const [name, lines] of files) {
      writeFileSync(join(directory, `${name}.csv.gz`), gzipSync(lines.join('\n')))
      const table = loadIpCountryTable(join(directory, `${name}.csv.gz`))
      for (const index of [0, 1, 25, 26, 4_096, 99_999, size - 1]) {
        const base = 0x0a00_0000 + index * 256 + 17
        expect(table.country(v4(base))).toBe(codeOf(index))
        expect(table.country(`${v6Prefix(index)}::17`)).toBe(codeOf(index + 7))
      }
      expect(table.country('9.255.255.255')).toBeUndefined()
      expect(table.country(`${v6Prefix(size)}::1`)).toBeUndefined()
    }
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
