import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readServeNetworkFlags, serveNetworkArgs } from './serve-network-flags'

describe('readServeNetworkFlags', () => {
  it('reads the flags and makes TLS paths absolute', () => {
    const flags = new Map<string, string | boolean>([
      ['bind', '100.64.1.20'],
      ['allow-ip', '100.64.0.0/10'],
      ['tls-cert', 'certs/fullchain.pem'],
      ['tls-key', 'certs/privkey.pem']
    ])
    const network = readServeNetworkFlags(flags)
    expect(network).toEqual({
      bind: '100.64.1.20',
      allowIp: '100.64.0.0/10',
      tlsCert: resolve('certs/fullchain.pem'),
      tlsKey: resolve('certs/privkey.pem')
    })
    expect(serveNetworkArgs(network)).toEqual([
      '--bind',
      '100.64.1.20',
      '--allow-ip',
      '100.64.0.0/10',
      '--tls-cert',
      resolve('certs/fullchain.pem'),
      '--tls-key',
      resolve('certs/privkey.pem')
    ])
  })

  it('returns nothing when no network flag is given', () => {
    expect(readServeNetworkFlags(new Map())).toEqual({})
  })

  it('refuses half a TLS pair and a valueless flag', () => {
    expect(() => readServeNetworkFlags(new Map([['tls-key', 'k.pem']]))).toThrow(
      'Use --tls-cert and --tls-key together.'
    )
    expect(() => readServeNetworkFlags(new Map([['allow-ip', true]]))).toThrow(
      'Missing value for --allow-ip.'
    )
  })
})
