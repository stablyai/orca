import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { BrowserNetworkDeferredSocket } from './browser-network-deferred-socket'

describe('BrowserNetworkDeferredSocket', () => {
  it('rejects an unattached write instead of acknowledging discarded bytes', async () => {
    const socket = new BrowserNetworkDeferredSocket()
    const callback = vi.fn()
    const onError = vi.fn()
    socket.on('error', onError)

    expect(socket.write(Buffer.from('unpublished'), callback)).toBe(false)
    expect(callback).not.toHaveBeenCalled()
    await Promise.resolve()

    expect(callback).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'browser_deferred_socket_not_connected' })
    )
    expect(onError).toHaveBeenCalledExactlyOnceWith(callback.mock.calls[0][0])
    expect(socket.destroyed).toBe(true)
    const lateSource = new PassThrough()
    socket.attach(lateSource)
    expect(lateSource.destroyed).toBe(true)
  })

  it('rejects writes after destruction without emitting another close', async () => {
    const socket = new BrowserNetworkDeferredSocket()
    const callback = vi.fn()
    const onClose = vi.fn()
    socket.on('close', onClose)
    socket.destroy()

    expect(socket.write(Buffer.from('discarded'), callback)).toBe(false)
    await Promise.resolve()

    expect(callback).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'browser_deferred_socket_closed' })
    )
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('destroys an attached source on failure and emits close only once', async () => {
    const socket = new BrowserNetworkDeferredSocket()
    const source = new PassThrough()
    const onClose = vi.fn()
    const onConnect = vi.fn()
    const error = new Error('route invalidated')
    socket.on('error', vi.fn())
    socket.on('close', onClose)
    socket.on('connect', onConnect)
    socket.attach(source)

    socket.fail(error)
    await new Promise((resolve) => setImmediate(resolve))

    expect(source.destroyed).toBe(true)
    expect(onClose).toHaveBeenCalledOnce()
    expect(onConnect).not.toHaveBeenCalled()
  })

  it('preserves the attached destination write receipt and backpressure', () => {
    const socket = new BrowserNetworkDeferredSocket()
    const source = new PassThrough()
    const callback = vi.fn()
    const write = vi.spyOn(source, 'write').mockReturnValue(false)
    socket.attach(source)
    const bytes = Buffer.from('pending destination write')

    expect(socket.write(bytes, callback)).toBe(false)
    expect(write).toHaveBeenCalledExactlyOnceWith(bytes, callback)
    expect(callback).not.toHaveBeenCalled()
    const error = new Error('destination write failed')
    const receipt = write.mock.calls[0][1] as unknown as (error: Error) => void
    receipt(error)
    expect(callback).toHaveBeenCalledExactlyOnceWith(error)
    socket.destroy()
  })

  it('binds consumption acknowledgments to the attached destination', () => {
    const socket = new BrowserNetworkDeferredSocket()
    const source = Object.assign(new PassThrough(), {
      consumed: 0,
      settleRead(bytes: number) {
        this.consumed += bytes
      }
    })
    socket.attach(source)
    const settleRead = socket.settleRead!

    settleRead(123)

    expect(source.consumed).toBe(123)
    socket.destroy()
  })

  it('does not advertise consumption acknowledgments for an ordinary stream', () => {
    const socket = new BrowserNetworkDeferredSocket()
    const source = new PassThrough()
    socket.attach(source)
    expect(socket.settleRead).toBeUndefined()
    socket.destroy()
  })

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
