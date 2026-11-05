import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const { createConnectionMock } = vi.hoisted(() => ({
  createConnectionMock: vi.fn()
}))

vi.mock('net', () => ({
  default: {
    createConnection: createConnectionMock
  }
}))

import { connectMacOSProviderSocket } from './macos-native-provider-socket'

class FakeSocket extends EventEmitter {
  destroy = vi.fn()
}

describe('connectMacOSProviderSocket', () => {
  it('removes socket listeners after a connection error', async () => {
    vi.useFakeTimers()
    try {
      const socket = new FakeSocket()
      createConnectionMock.mockReturnValueOnce(socket)

      const promise = connectMacOSProviderSocket('/tmp/orca-computer.sock', 50)
      await Promise.resolve()

      expect(socket.listenerCount('error')).toBe(1)
      expect(socket.listenerCount('connect')).toBe(1)

      const rejection = expect(promise).rejects.toThrow(
        'native macOS helper app did not open its socket'
      )
      socket.emit('error', new Error('ECONNREFUSED'))
      await vi.advanceTimersByTimeAsync(100)

      await rejection
      expect(socket.destroy).toHaveBeenCalledTimes(1)
      expect(socket.listenerCount('error')).toBe(0)
      expect(socket.listenerCount('connect')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('destroys the pending socket and removes listeners when aborted', async () => {
    const socket = new FakeSocket()
    createConnectionMock.mockReturnValueOnce(socket)
    const abort = new AbortController()

    const promise = connectMacOSProviderSocket('/tmp/orca-computer.sock', 5_000, abort.signal)
    await Promise.resolve()
    abort.abort()

    await expect(promise).rejects.toThrow('startup was cancelled')
    expect(socket.destroy).toHaveBeenCalledTimes(1)
    expect(socket.listenerCount('error')).toBe(0)
    expect(socket.listenerCount('connect')).toBe(0)
  })
})
