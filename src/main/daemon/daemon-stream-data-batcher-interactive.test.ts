import { describe, expect, it, vi } from 'vitest'
import { createHarness, parseWrite } from './daemon-stream-data-batcher-test-harness'

describe('DaemonStreamDataBatcher interactive output', () => {
  it('coalesces non-interactive output before writing to the stream socket', () => {
    vi.useFakeTimers()
    try {
      const { batcher, fake } = createHarness()

      batcher.enqueue('client-1', 'session-1', 'a')
      batcher.enqueue('client-1', 'session-1', 'b')

      expect(fake.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(7)
      expect(fake.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)

      expect(fake.write).toHaveBeenCalledTimes(1)
      expect(parseWrite(fake.write.mock.calls[0])).toMatchObject({
        type: 'event',
        event: 'data',
        sessionId: 'session-1',
        payload: { data: 'ab' }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends small redraws immediately after terminal input', () => {
    vi.useFakeTimers()
    try {
      const { batcher, fake, setNow } = createHarness()

      setNow(10)
      batcher.markInput('client-1', 'session-1')
      setNow(15)
      batcher.enqueue('client-1', 'session-1', '\x1b[20;2Hredraw')

      expect(fake.write).toHaveBeenCalledTimes(1)
      expect(parseWrite(fake.write.mock.calls[0])).toMatchObject({
        type: 'event',
        event: 'data',
        sessionId: 'session-1',
        payload: { data: '\x1b[20;2Hredraw' }
      })
      vi.advanceTimersByTime(8)
      expect(fake.write).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes only the interactive session when another session has pending output', () => {
    vi.useFakeTimers()
    try {
      const { batcher, fake, setNow } = createHarness()

      batcher.enqueue('client-1', 'background-session', 'background')
      setNow(20)
      batcher.markInput('client-1', 'interactive-session')
      setNow(21)
      batcher.enqueue('client-1', 'interactive-session', 'redraw')

      expect(fake.write).toHaveBeenCalledTimes(1)
      expect(parseWrite(fake.write.mock.calls[0])).toMatchObject({
        sessionId: 'interactive-session',
        payload: { data: 'redraw' }
      })

      vi.advanceTimersByTime(8)
      expect(fake.write).toHaveBeenCalledTimes(2)
      expect(parseWrite(fake.write.mock.calls[1])).toMatchObject({
        sessionId: 'background-session',
        payload: { data: 'background' }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for drain after an immediate interactive write backpressures', () => {
    vi.useFakeTimers()
    try {
      const { batcher, fake, setNow } = createHarness([false, true])

      setNow(10)
      batcher.markInput('client-1', 'session-1')
      setNow(11)
      batcher.enqueue('client-1', 'session-1', 'redraw')
      batcher.enqueue('client-1', 'session-2', 'queued')
      batcher.flush('client-1')

      expect(fake.write).toHaveBeenCalledTimes(1)
      fake.drain()

      expect(fake.write).toHaveBeenCalledTimes(2)
      expect(parseWrite(fake.write.mock.calls[1])).toMatchObject({
        sessionId: 'session-2',
        payload: { data: 'queued' }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('batches large output even after recent terminal input', () => {
    vi.useFakeTimers()
    try {
      const { batcher, fake, setNow } = createHarness()
      const largeOutput = 'x'.repeat(1025)

      setNow(10)
      batcher.markInput('client-1', 'session-1')
      setNow(11)
      batcher.enqueue('client-1', 'session-1', largeOutput)

      expect(fake.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(8)
      expect(fake.write).toHaveBeenCalledTimes(1)
      expect(parseWrite(fake.write.mock.calls[0])).toMatchObject({
        sessionId: 'session-1',
        payload: { data: largeOutput }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('batches stale output after the interactive window expires', () => {
    vi.useFakeTimers()
    try {
      const { batcher, fake, setNow } = createHarness()

      setNow(10)
      batcher.markInput('client-1', 'session-1')
      setNow(111)
      batcher.enqueue('client-1', 'session-1', 'stale redraw')

      expect(fake.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(8)
      expect(fake.write).toHaveBeenCalledTimes(1)
      expect(parseWrite(fake.write.mock.calls[0])).toMatchObject({
        sessionId: 'session-1',
        payload: { data: 'stale redraw' }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('forgets recent input when a session is cleared', () => {
    vi.useFakeTimers()
    try {
      const { batcher, fake, setNow } = createHarness()

      setNow(10)
      batcher.markInput('client-1', 'session-1')
      batcher.clearSessionInput('client-1', 'session-1')
      setNow(11)
      batcher.enqueue('client-1', 'session-1', 'redraw')

      expect(fake.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(8)
      expect(fake.write).toHaveBeenCalledTimes(1)
      expect(parseWrite(fake.write.mock.calls[0])).toMatchObject({
        sessionId: 'session-1',
        payload: { data: 'redraw' }
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
