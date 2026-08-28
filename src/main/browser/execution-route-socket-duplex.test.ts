import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { BrowserNetworkDeferredSocket } from './browser-network-deferred-socket'
import type { BrowserNetworkTunnelSocket } from './browser-network-tunnel-stream-state'
import { openExecutionRouteSocketAsDuplex } from './execution-route-socket-duplex'

class ScriptedSocket extends EventEmitter implements BrowserNetworkTunnelSocket {
  destroyed = false
  written: Uint8Array[] = []
  paused = false
  setNoDelay(): this {
    return this
  }
  pause(): this {
    this.paused = true
    return this
  }
  resume(): this {
    this.paused = false
    return this
  }
  write(bytes: Uint8Array, callback?: () => void): boolean {
    this.written.push(bytes)
    callback?.()
    return true
  }
  end(): this {
    this.emit('end')
    return this
  }
  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true
      this.emit('close')
    }
    return this
  }
}

describe('openExecutionRouteSocketAsDuplex', () => {
  it('resolves only after connect and forwards bytes both ways', async () => {
    const socket = new ScriptedSocket()
    const pending = openExecutionRouteSocketAsDuplex(socket)
    socket.emit('connect')
    const duplex = await pending

    duplex.write(Buffer.from('out'))
    expect(Buffer.concat(socket.written).toString()).toBe('out')

    const read = once(duplex, 'data')
    socket.emit('data', Buffer.from('in'))
    expect((await read)[0].toString()).toBe('in')
  })

  it('rejects when the dial errors before connecting', async () => {
    const socket = new ScriptedSocket()
    const pending = openExecutionRouteSocketAsDuplex(socket)
    socket.emit('error', new Error('forward refused'))
    await expect(pending).rejects.toThrow('forward refused')
    expect(socket.destroyed).toBe(true)
  })

  it('rejects when the dial closes before connecting', async () => {
    const socket = new ScriptedSocket()
    const pending = openExecutionRouteSocketAsDuplex(socket)
    socket.destroy()
    await expect(pending).rejects.toThrow('browser_local_route_connect_closed')
  })

  it('times out a dial that never connects', async () => {
    const socket = new ScriptedSocket()
    await expect(
      openExecutionRouteSocketAsDuplex(socket, { connectTimeoutMs: 20 })
    ).rejects.toThrow('browser_local_route_connect_timeout')
    expect(socket.destroyed).toBe(true)
  })

  it('delivers server-speaks-first bytes that flow before the connect microtask', async () => {
    // Why (review P2-1): BrowserNetworkDeferredSocket.attach() resumes the
    // source synchronously (data flows on the nextTick queue) but emits
    // 'connect' from a microtask — a banner buffered in the channel would be
    // emitted before any consumer listener exists and silently dropped.
    const channel = new PassThrough()
    channel.write(Buffer.from('220 server-banner\r\n'))
    const socket = new BrowserNetworkDeferredSocket()
    const pending = openExecutionRouteSocketAsDuplex(socket)
    // Why: attach() really runs inside an I/O callback (ssh2 forwardOut), where
    // nextTick-scheduled stream flow drains BEFORE the connect microtask; from
    // plain test-body context the order inverts and the bug hides.
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        socket.attach(channel)
        resolve()
      })
    })
    const duplex = await pending
    const received: Buffer[] = []
    duplex.on('data', (bytes: Buffer) => received.push(bytes))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(Buffer.concat(received).toString()).toBe('220 server-banner\r\n')
  })

  it('destroys the duplex when the connected socket closes', async () => {
    const socket = new ScriptedSocket()
    const pending = openExecutionRouteSocketAsDuplex(socket)
    socket.emit('connect')
    const duplex = await pending
    const closed = once(duplex, 'close')
    socket.destroy()
    await closed
    expect(duplex.destroyed).toBe(true)
  })
})
