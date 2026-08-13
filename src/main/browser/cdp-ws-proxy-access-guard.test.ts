import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { isAllowedCdpProxyRequest } from './cdp-ws-proxy-access-guard'

function request(
  headers: IncomingMessage['headers'],
  rawHeaders = Object.entries(headers).flatMap(([name, value]) =>
    value === undefined ? [] : [name, ...(Array.isArray(value) ? value : [value])]
  )
): IncomingMessage {
  return { headers, rawHeaders } as IncomingMessage
}

describe('CDP proxy request metadata', () => {
  it.each(['127.0.0.1:43127', 'LOCALHOST:43127', '[::1]:43127'])(
    'allows originless loopback authority %s',
    (host) => {
      expect(isAllowedCdpProxyRequest(request({ host }), 43_127)).toBe(true)
    }
  )

  it.each(['https://example.test', 'http://127.0.0.1:43127', '', 'null'])(
    'denies every present Origin value %j',
    (origin) => {
      expect(isAllowedCdpProxyRequest(request({ host: '127.0.0.1:43127', origin }), 43_127)).toBe(
        false
      )
    }
  )

  it.each([
    undefined,
    '',
    'example.test:43127',
    '127.0.0.1:43128',
    '127.0.0.1',
    '127.0.0.1:+43127',
    '127.0.0.1:043127',
    '127.0.0.1:4.3127e4',
    '127.0.0.1:43127,example.test:43127',
    '127.0.0.1 :43127',
    '127.1:43127',
    '2130706433:43127',
    '0x7f000001:43127',
    '::1:43127',
    '[0:0:0:0:0:0:0:1]:43127',
    '[::ffff:127.0.0.1]:43127'
  ])('denies non-canonical or mismatched Host %j', (host) => {
    expect(isAllowedCdpProxyRequest(request({ host }), 43_127)).toBe(false)
  })

  it('denies duplicate Host headers, including identical values', () => {
    const headers = { host: '127.0.0.1:43127' }

    expect(
      isAllowedCdpProxyRequest(
        request(headers, ['Host', headers.host, 'Host', headers.host]),
        43_127
      )
    ).toBe(false)
  })

  it('denies normalized and raw header disagreement', () => {
    expect(
      isAllowedCdpProxyRequest(
        request({ host: '127.0.0.1:43127' }, ['Host', 'example.test:43127']),
        43_127
      )
    ).toBe(false)
    expect(
      isAllowedCdpProxyRequest(
        request({ host: '127.0.0.1:43127' }, ['Host', '127.0.0.1:43127', 'Origin', 'null']),
        43_127
      )
    ).toBe(false)
  })

  it('denies malformed raw header metadata', () => {
    expect(isAllowedCdpProxyRequest(request({ host: '127.0.0.1:43127' }, ['Host']), 43_127)).toBe(
      false
    )
    expect(
      isAllowedCdpProxyRequest(request({ host: '127.0.0.1:43127' }, ['Origin', 'null']), 43_127)
    ).toBe(false)
  })

  it('ignores forwarding metadata on the direct listener', () => {
    expect(
      isAllowedCdpProxyRequest(
        request({
          host: '127.0.0.1:43127',
          forwarded: 'host=example.test:43127;proto=https',
          'x-forwarded-host': 'example.test:43127',
          'x-forwarded-proto': 'https'
        }),
        43_127
      )
    ).toBe(true)
    expect(
      isAllowedCdpProxyRequest(
        request({ host: 'example.test:43127', 'x-forwarded-host': '127.0.0.1:43127' }),
        43_127
      )
    ).toBe(false)
  })

  it.each([0, -1, 65_536, 43_127.5, Number.NaN])('denies invalid bound port %j', (port) => {
    expect(isAllowedCdpProxyRequest(request({ host: `127.0.0.1:${port}` }), port)).toBe(false)
  })
})
