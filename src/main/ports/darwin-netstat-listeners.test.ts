import { describe, expect, it } from 'vitest'
import { DarwinNetstatListeners, parseDarwinNetstatListeners } from './darwin-netstat-listeners'

const HEADER =
  'Active Internet connections (including servers)\nProto Recv-Q Send-Q Local Address Foreign Address (state)\n'

function row(address: string, state = 'LISTEN', protocol = 'tcp6'): string {
  return `${protocol} 0 0 ${address} *.* ${state}\n`
}

describe('Darwin numeric long netstat contract', () => {
  it('preserves actual global/scoped IPv6, wildcard and IPv4 endpoints without owner fields', () => {
    expect(
      parseDarwinNetstatListeners(
        HEADER +
          [
            row('2601:645:c100:105b:1888:85d6:248a:279c.9422'),
            row('fe80::43b:efce:e94e:e83b%en0.9423'),
            row('::1.9424'),
            row('*.9425', 'LISTEN', 'tcp46'),
            row('127.0.0.1.3000', 'LISTEN', 'tcp4')
          ].join('')
      )
    ).toEqual([
      { host: '2601:645:c100:105b:1888:85d6:248a:279c', port: 9422 },
      { host: 'fe80::43b:efce:e94e:e83b%en0', port: 9423 },
      { host: '::1', port: 9424 },
      { host: '*', port: 9425 },
      { host: '127.0.0.1', port: 3000 }
    ])
  })

  it('omits address-incomplete 39-character scopes instead of inventing an interface', () => {
    const real = 'fe80::ffff:ffff:ffff:ffff%bridge123456789'
    expect(real).toHaveLength(41)
    expect(parseDarwinNetstatListeners(HEADER + row(`${real.slice(0, 39)}.3000`))).toEqual([])
  })

  it('keeps listeners when Darwin reports an incoming handshake as SYN_RCVD', () => {
    expect(
      parseDarwinNetstatListeners(
        `${HEADER}${row('127.0.0.1.3000', 'LISTEN', 'tcp4')}tcp4 0 0 192.0.2.1.443 192.0.2.2.50000 SYN_RCVD\n`
      )
    ).toEqual([{ host: '127.0.0.1', port: 3000 }])
  })

  it('drains many nonlisteners across arbitrary chunks without retaining their dump', () => {
    const parser = new DarwinNetstatListeners()
    parser.write(HEADER.slice(0, 27))
    parser.write(HEADER.slice(27))
    for (let i = 0; i < 25_000; i++) {
      parser.write(row('::1.50000', 'ESTABLISHED'))
    }
    const listen = row('::1.3000')
    parser.write(listen.slice(0, 9))
    parser.write(listen.slice(9))
    expect(parser.finish()).toBe(HEADER + listen)
  })

  it('accepts the supported empty formats and refuses diagnostics, partial or unknown output', () => {
    expect(parseDarwinNetstatListeners('')).toEqual([])
    expect(parseDarwinNetstatListeners(HEADER)).toEqual([])
    for (const output of [
      `${HEADER}netstat: sysctl failed\n`,
      HEADER + row('::1.3000').trimEnd(),
      HEADER + row('bad.3000'),
      HEADER + row('::1.70000'),
      HEADER + row('::1.3000', 'UNKNOWN'),
      'Active Internet connections (including servers)\n',
      'other header\n'
    ]) {
      expect(() => parseDarwinNetstatListeners(output)).toThrow()
    }
  })
})
