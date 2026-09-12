import { PassThrough } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:net', () => ({ connect: vi.fn() }))

import { connect } from 'node:net'
import { BunWebSocketUpgradeProxy } from './bun-websocket-upgrade-proxy'

function request(): IncomingMessage {
  return {
    method: 'GET',
    url: '/rpc?client=one',
    httpVersion: '1.1',
    rawHeaders: ['Host', '127.0.0.1:7777', 'Upgrade', 'websocket']
  } as IncomingMessage
}

describe('Bun WebSocket upgrade proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('forwards the exact upgrade request and buffered head after loopback connects', () => {
    const upstream = new PassThrough()
    const downstream = new PassThrough()
    const write = vi.spyOn(upstream, 'write')
    vi.mocked(connect).mockReturnValue(upstream as unknown as Socket)
    const proxy = new BunWebSocketUpgradeProxy(43123)
    const head = Buffer.from('buffered-frame')

    proxy.handle(request(), downstream, head)
    upstream.emit('connect')

    expect(connect).toHaveBeenCalledWith({ host: '127.0.0.1', port: 43123 })
    expect(write).toHaveBeenNthCalledWith(
      1,
      'GET /rpc?client=one HTTP/1.1\r\nHost: 127.0.0.1:7777\r\nUpgrade: websocket\r\n\r\n',
      'latin1'
    )
    expect(write).toHaveBeenNthCalledWith(2, head)

    proxy.stop()
    expect(upstream.destroyed).toBe(true)
    expect(downstream.destroyed).toBe(true)
  })

  it('destroys pending sockets on stop and rejects later upgrades', () => {
    const upstream = new PassThrough()
    const pending = new PassThrough()
    vi.mocked(connect).mockReturnValue(upstream as unknown as Socket)
    const proxy = new BunWebSocketUpgradeProxy(43123)

    proxy.handle(request(), pending, Buffer.alloc(0))
    proxy.stop()

    expect(upstream.destroyed).toBe(true)
    expect(pending.destroyed).toBe(true)

    const rejected = new PassThrough()
    proxy.handle(request(), rejected, Buffer.alloc(0))
    expect(rejected.destroyed).toBe(true)
    expect(connect).toHaveBeenCalledOnce()
  })
})
