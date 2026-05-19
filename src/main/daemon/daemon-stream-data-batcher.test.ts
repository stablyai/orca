import { describe, expect, it, vi } from 'vitest'
import type { Socket } from 'net'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'

function createFakeSocket(writeResults: boolean[]): {
  socket: Socket
  write: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
  drain: () => void
  close: () => void
  error: () => void
  staleDrain: () => void
  staleClose: () => void
  staleError: () => void
} {
  let drainHandler: (() => void) | null = null
  let closeHandler: (() => void) | null = null
  let errorHandler: (() => void) | null = null
  let removedDrainHandler: (() => void) | null = null
  let removedCloseHandler: (() => void) | null = null
  let removedErrorHandler: (() => void) | null = null
  const write = vi.fn(() => writeResults.shift() ?? true)
  const removeListener = vi.fn((event: string, handler: () => void) => {
    if (event === 'drain' && drainHandler === handler) {
      removedDrainHandler = handler
      drainHandler = null
    } else if (event === 'close' && closeHandler === handler) {
      removedCloseHandler = handler
      closeHandler = null
    } else if (event === 'error' && errorHandler === handler) {
      removedErrorHandler = handler
      errorHandler = null
    }
    return socket
  })
  const socket = {
    destroyed: false,
    write,
    removeListener,
    once: vi.fn((event: string, handler: () => void) => {
      if (event === 'drain') {
        drainHandler = handler
      } else if (event === 'close') {
        closeHandler = handler
      } else if (event === 'error') {
        errorHandler = handler
      }
      return socket
    })
  } as unknown as Socket

  return {
    socket,
    write,
    removeListener,
    drain: () => drainHandler?.(),
    close: () => closeHandler?.(),
    error: () => errorHandler?.(),
    staleDrain: () => removedDrainHandler?.(),
    staleClose: () => removedCloseHandler?.(),
    staleError: () => removedErrorHandler?.()
  }
}

describe('DaemonStreamDataBatcher', () => {
  it('drops queued output when the backpressured stream errors before drain', () => {
    const fake = createFakeSocket([false, true])
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: fake.socket }))

    batcher.enqueue('client-1', 'session-a', 'first')
    batcher.enqueue('client-1', 'session-b', 'second')

    batcher.flush('client-1')
    fake.error()
    fake.drain()

    expect(fake.write).toHaveBeenCalledTimes(1)
  })

  it('cleans up unused backpressure listeners after drain', () => {
    const fake = createFakeSocket([false, true])
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: fake.socket }))

    batcher.enqueue('client-1', 'session-a', 'first')
    batcher.enqueue('client-1', 'session-b', 'second')

    batcher.flush('client-1')
    fake.drain()

    expect(fake.removeListener).toHaveBeenCalledWith('close', expect.any(Function))
    expect(fake.removeListener).toHaveBeenCalledWith('error', expect.any(Function))
    fake.close()

    expect(fake.write).toHaveBeenCalledTimes(2)
  })

  it('drops queued output when the backpressured stream closes before drain', () => {
    const fake = createFakeSocket([false, true])
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: fake.socket }))

    batcher.enqueue('client-1', 'session-a', 'first')
    batcher.enqueue('client-1', 'session-b', 'second')

    batcher.flush('client-1')
    fake.close()
    fake.drain()

    expect(fake.write).toHaveBeenCalledTimes(1)
  })

  it('does not keep queued output forever when drain never arrives', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fake = createFakeSocket([false, true])
      const onStreamFailure = vi.fn()
      const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: fake.socket }), {
        onStreamFailure
      })

      batcher.enqueue('client-1', 'session-a', 'first')
      batcher.enqueue('client-1', 'session-b', 'second')
      batcher.flush('client-1')

      vi.advanceTimersByTime(30_000)
      fake.drain()

      expect(fake.write).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(
        '[daemon] PTY stream socket drain timed out',
        expect.objectContaining({ clientId: 'client-1' })
      )
      expect(onStreamFailure).toHaveBeenCalledWith('client-1')
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('orders exit behind queued data while waiting for drain', () => {
    const fake = createFakeSocket([false, true, true])
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: fake.socket }))

    batcher.enqueue('client-1', 'session-a', 'first')
    batcher.flush('client-1')
    batcher.enqueue('client-1', 'session-b', 'second')
    batcher.enqueueExit('client-1', 'session-a', 0)

    expect(fake.write).toHaveBeenCalledTimes(1)
    fake.drain()

    expect(fake.write).toHaveBeenCalledTimes(3)
    expect(fake.write.mock.calls[1]?.[0]).toContain('"data"')
    expect(fake.write.mock.calls[1]?.[0]).toContain('second')
    expect(fake.write.mock.calls[2]?.[0]).toContain('"exit"')
  })

  it('waits for socket drain before continuing after stream backpressure', () => {
    const fake = createFakeSocket([false, true])
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: fake.socket }))

    batcher.enqueue('client-1', 'session-a', 'first')
    batcher.enqueue('client-1', 'session-b', 'second')

    batcher.flush('client-1')
    expect(fake.write).toHaveBeenCalledTimes(1)
    expect(fake.write.mock.calls[0]?.[0]).toContain('first')

    fake.drain()

    expect(fake.write).toHaveBeenCalledTimes(2)
    expect(fake.write.mock.calls[1]?.[0]).toContain('second')
  })

  it('queues additional output while waiting for drain', () => {
    const fake = createFakeSocket([false, true])
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: fake.socket }))

    batcher.enqueue('client-1', 'session-a', 'first')
    batcher.flush('client-1')

    batcher.enqueue('client-1', 'session-b', 'second')
    batcher.flush('client-1')
    expect(fake.write).toHaveBeenCalledTimes(1)

    fake.drain()

    expect(fake.write).toHaveBeenCalledTimes(2)
    expect(fake.write.mock.calls[1]?.[0]).toContain('second')
  })

  it('ignores stale drain callbacks after clearing an old client stream', () => {
    const oldStream = createFakeSocket([false, true])
    const newStream = createFakeSocket([true])
    let streamSocket = oldStream.socket
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket }))

    batcher.enqueue('client-1', 'session-a', 'first')
    batcher.enqueue('client-1', 'session-b', 'second')
    batcher.flush('client-1')

    batcher.clear('client-1')
    streamSocket = newStream.socket
    batcher.enqueue('client-1', 'session-c', 'third')
    batcher.flush('client-1')
    oldStream.staleDrain()

    expect(oldStream.write).toHaveBeenCalledTimes(1)
    expect(newStream.write).toHaveBeenCalledTimes(1)
    expect(newStream.write.mock.calls[0]?.[0]).toContain('third')
  })

  it('ignores stale close and error callbacks after clearing an old client stream', () => {
    const oldStream = createFakeSocket([false, true])
    const newStream = createFakeSocket([true])
    let streamSocket = oldStream.socket
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket }))

    batcher.enqueue('client-1', 'session-a', 'first')
    batcher.enqueue('client-1', 'session-b', 'second')
    batcher.flush('client-1')

    batcher.clear('client-1')
    streamSocket = newStream.socket
    batcher.enqueue('client-1', 'session-c', 'third')
    batcher.flush('client-1')
    oldStream.staleClose()
    oldStream.staleError()

    expect(oldStream.write).toHaveBeenCalledTimes(1)
    expect(newStream.write).toHaveBeenCalledTimes(1)
    expect(newStream.write.mock.calls[0]?.[0]).toContain('third')
  })

  it('fails the stream when queued output exceeds the hard cap', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fake = createFakeSocket([true])
      const onStreamFailure = vi.fn()
      const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: fake.socket }), {
        onStreamFailure
      })

      batcher.enqueue('client-1', 'session-a', 'x'.repeat(8 * 1024 * 1024 + 1))

      expect(fake.write).not.toHaveBeenCalled()
      expect(onStreamFailure).toHaveBeenCalledWith('client-1')
      expect(warn).toHaveBeenCalledWith(
        '[daemon] PTY stream socket queue exceeded limit',
        expect.objectContaining({ clientId: 'client-1' })
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('fails the stream when queued output cumulatively exceeds the hard cap while backpressured', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const fake = createFakeSocket([false])
      const onStreamFailure = vi.fn()
      const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: fake.socket }), {
        onStreamFailure
      })

      batcher.enqueue('client-1', 'session-a', 'first')
      batcher.flush('client-1')
      batcher.enqueue('client-1', 'session-a', 'x'.repeat(8 * 1024 * 1024 + 1))

      expect(fake.write).toHaveBeenCalledTimes(1)
      expect(onStreamFailure).toHaveBeenCalledWith('client-1')
      expect(warn).toHaveBeenCalledWith(
        '[daemon] PTY stream socket queue exceeded limit',
        expect.objectContaining({ clientId: 'client-1' })
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('splits very large output into bounded stream frames', () => {
    const fake = createFakeSocket([true, true])
    const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: fake.socket }))

    batcher.enqueue('client-1', 'session-a', 'x'.repeat(65 * 1024))
    batcher.flush('client-1')

    expect(fake.write).toHaveBeenCalledTimes(2)
  })

  it('yields between large queued flushes', () => {
    vi.useFakeTimers()
    try {
      const fake = createFakeSocket(Array.from({ length: 1025 }, () => true))
      const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: fake.socket }))

      for (let i = 0; i < 1025; i++) {
        batcher.enqueue('client-1', `session-${i}`, `${i}`)
      }
      batcher.flush('client-1')

      expect(fake.write).toHaveBeenCalledTimes(1024)
      vi.advanceTimersByTime(0)
      expect(fake.write).toHaveBeenCalledTimes(1025)
    } finally {
      vi.useRealTimers()
    }
  })
})
