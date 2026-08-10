import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CdpWsProxy } from './cdp-ws-proxy'

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() }
}))

type RequestHandler = {
  port: number
  handleHttpRequest: (request: IncomingMessage, response: ServerResponse) => void
}

function requestStatus(headers: Record<string, string | undefined>): number {
  const proxy = new CdpWsProxy({} as never) as unknown as RequestHandler
  proxy.port = 43_127
  let status = 0
  const response = {
    writeHead: (nextStatus: number) => {
      status = nextStatus
      return response
    },
    end: vi.fn()
  } as unknown as ServerResponse
  proxy.handleHttpRequest(
    {
      headers,
      rawHeaders: Object.entries(headers).flatMap(([name, value]) =>
        value === undefined ? [] : [name, value]
      ),
      url: '/json/version'
    } as unknown as IncomingMessage,
    response
  )
  return status
}

describe('CdpWsProxy discovery request access', () => {
  it('allows an originless request for the exact loopback authority', () => {
    expect(requestStatus({ host: '127.0.0.1:43127' })).toBe(200)
    expect(requestStatus({ host: 'localhost:43127' })).toBe(200)
    expect(requestStatus({ host: '[::1]:43127' })).toBe(200)
  })

  it.each(['https://example.test', '', 'null'])('denies any present Origin value: %j', (origin) => {
    expect(requestStatus({ host: '127.0.0.1:43127', origin })).toBe(403)
  })

  it.each([
    undefined,
    'example.test:43127',
    '127.0.0.1:43128',
    '127.0.0.1',
    '127.0.0.1:+43127',
    '127.0.0.1:043127',
    '127.0.0.1:4.3127e4',
    '::1:43127',
    '127.1:43127',
    '2130706433:43127',
    '[::ffff:127.0.0.1]:43127'
  ])('denies a non-canonical or mismatched Host: %j', (host) => {
    expect(requestStatus({ host })).toBe(403)
  })
})
