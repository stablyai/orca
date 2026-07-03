import { describe, it, expect } from 'vitest'
import { parseServerArgs } from './node-server-args'

describe('parseServerArgs', () => {
  it('defaults to no flags', () => {
    const o = parseServerArgs([])
    expect(o).toMatchObject({ help: false, mobilePairing: false, noPairing: false, json: false })
    expect(o.port).toBeUndefined()
  })

  it('parses --serve-port with a space-separated value', () => {
    expect(parseServerArgs(['--serve-port', '6768']).port).toBe(6768)
  })

  it('parses --serve-port=VALUE inline', () => {
    expect(parseServerArgs(['--serve-port=7000']).port).toBe(7000)
  })

  it('rejects an out-of-range port', () => {
    expect(() => parseServerArgs(['--serve-port', '99999'])).toThrow()
  })

  it('rejects non-numeric port suffixes', () => {
    expect(() => parseServerArgs(['--serve-port', '123abc'])).toThrow('Invalid port value: 123abc')
  })

  it('does not parse mistyped flag prefixes as real options', () => {
    const o = parseServerArgs([
      '--serve-portal=7000',
      '--user-data-dir=/tmp/not-orca',
      '--pairing-addresses=example.com'
    ])

    expect(o.port).toBeUndefined()
    expect(o.userDataPath).toBeUndefined()
    expect(o.pairingAddress).toBeUndefined()
  })

  it('rejects missing values for value options', () => {
    expect(() => parseServerArgs(['--user-data'])).toThrow('Missing value for --user-data')
    expect(() => parseServerArgs(['--user-data='])).toThrow('Missing value for --user-data')
    expect(() => parseServerArgs(['--pairing-address', '--json'])).toThrow(
      'Missing value for --pairing-address'
    )
  })

  it('parses pairing + json flags', () => {
    const o = parseServerArgs(['--mobile-pairing', '--json', '--pairing-address', 'example.com'])
    expect(o.mobilePairing).toBe(true)
    expect(o.json).toBe(true)
    expect(o.pairingAddress).toBe('example.com')
  })

  it('parses --no-pairing and --user-data', () => {
    const o = parseServerArgs(['--no-pairing', '--user-data', '/data'])
    expect(o.noPairing).toBe(true)
    expect(o.userDataPath).toBe('/data')
  })

  it('recognizes --help', () => {
    expect(parseServerArgs(['--help']).help).toBe(true)
    expect(parseServerArgs(['-h']).help).toBe(true)
  })
})
