import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { BrowserNetworkDeferredSocket } from './browser-network-deferred-socket'

describe('BrowserNetworkDeferredSocket', () => {
  it('emits close once when destroyed before its source attaches', () => {
    const socket = new BrowserNetworkDeferredSocket()
    const source = new PassThrough()
    const onClose = vi.fn()
    socket.on('close', onClose)

    socket.destroy()
    socket.attach(source)
    source.emit('close')

    expect(onClose).toHaveBeenCalledOnce()
    expect(source.destroyed).toBe(true)
  })

  it('emits one close when an attached source closes after destroy', async () => {
    const socket = new BrowserNetworkDeferredSocket()
    const source = new PassThrough()
    const onClose = vi.fn()
    socket.on('close', onClose)
    socket.attach(source)

    socket.destroy()
    await new Promise((resolve) => setImmediate(resolve))

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('settles a credit-accounted source only after listeners take the bytes', async () => {
    const socket = new BrowserNetworkDeferredSocket()
    const settleRead = vi.fn()
    const source = Object.assign(new PassThrough(), { settleRead })
    const received: number[] = []
    socket.on('data', (bytes: Buffer) => {
      expect(settleRead).toHaveBeenCalledTimes(received.length)
      received.push(bytes.byteLength)
    })
    socket.pause()
    socket.attach(source)

    source.write(Buffer.alloc(5))
    await new Promise((resolve) => setImmediate(resolve))
    expect(settleRead).not.toHaveBeenCalled()

    socket.resume()
    await vi.waitFor(() => expect(settleRead).toHaveBeenCalledWith(5))
    expect(received).toEqual([5])
  })
})
