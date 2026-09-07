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
})
