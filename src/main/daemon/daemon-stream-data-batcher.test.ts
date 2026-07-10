import { describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import { EventEmitter } from 'node:events'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import { createNdjsonParser } from './ndjson'

function createBatcher(options?: ConstructorParameters<typeof DaemonStreamDataBatcher>[1]) {
  const streamSocket = Object.assign(new EventEmitter(), {
    destroyed: false,
    write: vi.fn(() => true)
  }) as unknown as Socket & { write: ReturnType<typeof vi.fn> }
  const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket }), options)
  return { batcher, streamSocket }
}

describe('DaemonStreamDataBatcher', () => {
  it('drops event writes aimed at a destroyed socket without clearing the live queue', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher()
      streamSocket.write.mockReturnValueOnce(false)
      batcher.enqueue('client-1', 'session-1', 'head', {
        flushImmediately: true,
        flushMaxChars: 1024
      })
      batcher.enqueue('client-1', 'session-1', 'tail', {
        flushImmediately: true,
        flushMaxChars: 1024
      })
      expect(streamSocket.write).toHaveBeenCalledTimes(1)

      // A stale destroyed socket (captured across a same-clientId reconnect)
      // must not wipe the live socket's queued output or leak drain listeners.
      const staleSocket = Object.assign(new EventEmitter(), {
        destroyed: true,
        write: vi.fn(() => false)
      }) as unknown as Socket & { write: ReturnType<typeof vi.fn> }
      batcher.writeEventLine(
        'client-1',
        staleSocket,
        'session-1',
        '{"type":"event","event":"exit","sessionId":"session-1","payload":{"code":0}}\n'
      )
      expect(staleSocket.write).not.toHaveBeenCalled()

      streamSocket.emit('drain')
      const writes = streamSocket.write.mock.calls.map((c) => String(c[0]))
      expect(writes.some((w) => w.includes('"data":"tail"'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces background output before writing daemon stream events', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher()

      batcher.enqueue('client-1', 'session-1', 'a')
      batcher.enqueue('client-1', 'session-1', 'b')

      expect(streamSocket.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(7)
      expect(streamSocket.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)

      expect(streamSocket.write).toHaveBeenCalledTimes(1)
      expect(String(streamSocket.write.mock.calls[0]?.[0])).toContain('"data":"ab"')
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes small interactive output immediately', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher()

      batcher.enqueue('client-1', 'session-1', '\x1b[20;2Hredraw', {
        flushImmediately: true,
        flushMaxChars: 1024
      })

      expect(streamSocket.write).toHaveBeenCalledTimes(1)
      expect(String(streamSocket.write.mock.calls[0]?.[0])).toContain('\\u001b[20;2Hredraw')
      vi.advanceTimersByTime(8)
      expect(streamSocket.write).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps large pending output batched even when an interactive redraw follows', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher()
      const pending = 'x'.repeat(1020)

      batcher.enqueue('client-1', 'session-1', pending)
      batcher.enqueue('client-1', 'session-1', 'redraw', {
        flushImmediately: true,
        flushMaxChars: 1024
      })

      expect(streamSocket.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(8)
      expect(streamSocket.write).toHaveBeenCalledTimes(1)
      expect(String(streamSocket.write.mock.calls[0]?.[0])).toContain(`${pending}redraw`)
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes interactive output for one session while another session has large pending output', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher()
      const background = 'x'.repeat(2048)

      batcher.enqueue('client-1', 'session-background', background)
      batcher.enqueue('client-1', 'session-interactive', 'echo', {
        flushImmediately: true,
        flushMaxChars: 1024
      })

      expect(streamSocket.write).toHaveBeenCalledTimes(1)
      expect(String(streamSocket.write.mock.calls[0]?.[0])).toContain(
        '"sessionId":"session-interactive"'
      )
      expect(String(streamSocket.write.mock.calls[0]?.[0])).toContain('"data":"echo"')

      vi.advanceTimersByTime(8)
      expect(streamSocket.write).toHaveBeenCalledTimes(2)
      expect(String(streamSocket.write.mock.calls[1]?.[0])).toContain(
        '"sessionId":"session-background"'
      )
      expect(String(streamSocket.write.mock.calls[1]?.[0])).toContain(`"data":"${background}"`)
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes large stream data as parser-sized NDJSON events', () => {
    vi.useFakeTimers()
    try {
      const maxLineBytes = 256
      const { batcher, streamSocket } = createBatcher({ maxLineBytes })
      const data = 'x'.repeat(maxLineBytes * 3)
      const onMessage = vi.fn()
      const onError = vi.fn()
      const parser = createNdjsonParser(onMessage, onError, { maxLineBytes })

      batcher.enqueue('client-1', 'session-1', data)
      vi.advanceTimersByTime(8)
      for (const [line] of streamSocket.write.mock.calls) {
        parser.feed(String(line))
      }

      expect(onError).not.toHaveBeenCalled()
      expect(onMessage).toHaveBeenCalled()
      expect(
        onMessage.mock.calls
          .map(([message]) => (message as { payload?: { data?: string } }).payload?.data ?? '')
          .join('')
      ).toBe(data)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pauses stream writes when the socket applies backpressure', () => {
    vi.useFakeTimers()
    try {
      const maxLineBytes = 256
      const { batcher, streamSocket } = createBatcher({ maxLineBytes })
      streamSocket.write.mockReturnValueOnce(false).mockReturnValue(true)

      batcher.enqueue('client-1', 'session-1', 'x'.repeat(maxLineBytes * 3))
      vi.advanceTimersByTime(8)

      expect(streamSocket.write).toHaveBeenCalledTimes(1)

      streamSocket.emit('drain')

      expect(streamSocket.write.mock.calls.length).toBeGreaterThan(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('queues later stream data behind a backpressured socket until drain', () => {
    vi.useFakeTimers()
    try {
      const maxLineBytes = 256
      const { batcher, streamSocket } = createBatcher({ maxLineBytes })
      streamSocket.write.mockReturnValueOnce(false).mockReturnValue(true)

      batcher.enqueue('client-1', 'session-1', 'x'.repeat(maxLineBytes * 3))
      vi.advanceTimersByTime(8)
      batcher.enqueue('client-1', 'session-2', 'interactive', {
        flushImmediately: true,
        flushMaxChars: 1024
      })

      expect(streamSocket.write).toHaveBeenCalledTimes(1)

      streamSocket.emit('drain')

      expect(
        streamSocket.write.mock.calls.some(([line]) =>
          String(line).includes('"sessionId":"session-2"')
        )
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('globally clears clients that only have backpressured stream writes', () => {
    vi.useFakeTimers()
    try {
      const maxLineBytes = 256
      const { batcher, streamSocket } = createBatcher({ maxLineBytes })
      streamSocket.write.mockReturnValueOnce(false).mockReturnValue(true)

      batcher.enqueue('client-1', 'session-1', 'x'.repeat(maxLineBytes * 3))
      vi.advanceTimersByTime(8)

      expect(streamSocket.write).toHaveBeenCalledTimes(1)
      expect(streamSocket.listenerCount('drain')).toBe(1)

      batcher.clear()
      expect(streamSocket.listenerCount('drain')).toBe(0)
      expect(streamSocket.listenerCount('close')).toBe(0)
      expect(streamSocket.listenerCount('error')).toBe(0)

      streamSocket.write.mockClear()
      streamSocket.emit('drain')

      expect(streamSocket.write).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('prioritizes interactive session output over unrelated backpressured backlog on drain', () => {
    vi.useFakeTimers()
    try {
      const maxLineBytes = 256
      const { batcher, streamSocket } = createBatcher({ maxLineBytes })
      streamSocket.write.mockReturnValueOnce(false).mockReturnValue(true)

      batcher.enqueue('client-1', 'session-background', 'x'.repeat(maxLineBytes * 3))
      vi.advanceTimersByTime(8)
      batcher.enqueue('client-1', 'session-interactive', 'prompt-redraw', {
        flushImmediately: true,
        flushMaxChars: 1024
      })

      expect(streamSocket.write).toHaveBeenCalledTimes(1)
      streamSocket.write.mockClear()

      streamSocket.emit('drain')

      expect(String(streamSocket.write.mock.calls[0]?.[0])).toContain(
        '"sessionId":"session-interactive"'
      )
      expect(String(streamSocket.write.mock.calls[0]?.[0])).toContain('"data":"prompt-redraw"')
      expect(
        streamSocket.write.mock.calls.some(([line]) =>
          String(line).includes('"sessionId":"session-background"')
        )
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds queued stream data while a socket remains backpressured', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher({
        maxLineBytes: 256,
        maxBackpressuredBytes: 1
      })
      streamSocket.write.mockReturnValueOnce(false).mockReturnValue(true)

      batcher.enqueue('client-1', 'session-old', 'old-output'.repeat(200))
      vi.advanceTimersByTime(8)

      for (let index = 0; index < 5; index += 1) {
        batcher.enqueue('client-1', `session-new-${index}`, `new-output-${index}`, {
          flushImmediately: true,
          flushMaxChars: 1024
        })
      }

      expect(streamSocket.write).toHaveBeenCalledTimes(1)
      streamSocket.write.mockClear()

      streamSocket.emit('drain')

      expect(streamSocket.write).toHaveBeenCalledTimes(1)
      expect(String(streamSocket.write.mock.calls[0]?.[0])).toContain('"sessionId":"session-new-4"')
    } finally {
      vi.useRealTimers()
    }
  })
})
