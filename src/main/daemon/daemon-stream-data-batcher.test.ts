import { describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import { EventEmitter } from 'node:events'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import { createNdjsonParser } from './ndjson'

class FakeStreamSocket extends EventEmitter {
  destroyed = false
  write = vi.fn((_line: string) => true)
}

function createBatcher(options?: ConstructorParameters<typeof DaemonStreamDataBatcher>[1]) {
  const streamSocket = new FakeStreamSocket() as unknown as Socket & FakeStreamSocket
  const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket }), options)
  return { batcher, streamSocket }
}

describe('DaemonStreamDataBatcher', () => {
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

  it('pauses daemon stream writes after socket backpressure until drain', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher({ maxLineBytes: 128 })
      streamSocket.write
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)

      batcher.enqueue('client-1', 'session-1', 'a'.repeat(512))
      vi.advanceTimersByTime(8)

      expect(streamSocket.write).toHaveBeenCalledTimes(1)
      batcher.enqueue('client-1', 'session-2', 'interactive', {
        flushImmediately: true,
        flushMaxChars: 1024
      })
      expect(streamSocket.write).toHaveBeenCalledTimes(1)

      streamSocket.emit('drain')

      expect(streamSocket.write.mock.calls.length).toBeGreaterThan(1)
      const lines = streamSocket.write.mock.calls.map(([line]) => String(line))
      expect(lines.some((line) => line.includes('"sessionId":"session-2"'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('prioritizes flush-immediate output ahead of queued background backlog on drain', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher({ maxLineBytes: 128 })
      streamSocket.write.mockReturnValueOnce(false).mockReturnValue(true)

      batcher.enqueue('client-1', 'session-background', 'b'.repeat(512))
      vi.advanceTimersByTime(8)
      batcher.enqueue('client-1', 'session-active', 'active', {
        flushImmediately: true,
        flushMaxChars: 1024
      })
      streamSocket.write.mockClear()

      streamSocket.emit('drain')

      const firstWrittenAfterDrain = String(streamSocket.write.mock.calls[0]?.[0] ?? '')
      expect(firstWrittenAfterDrain).toContain('"sessionId":"session-active"')
      expect(firstWrittenAfterDrain).toContain('"data":"active"')
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps queued daemon stream writes to the newest tail while backpressured', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher({
        maxBackpressuredBytes: 512,
        maxLineBytes: 256
      })
      streamSocket.write.mockReturnValueOnce(false).mockReturnValue(true)

      batcher.enqueue('client-1', 'session-1', 'first-background')
      vi.advanceTimersByTime(8)
      for (let index = 0; index < 30; index += 1) {
        batcher.enqueue('client-1', `session-${index + 2}`, `chunk-${index}`)
      }
      vi.advanceTimersByTime(8)
      streamSocket.write.mockClear()

      streamSocket.emit('drain')

      const written = streamSocket.write.mock.calls.map(([line]) => String(line)).join('\n')
      expect(written).not.toContain('chunk-0')
      expect(written).toContain('chunk-29')
      expect(streamSocket.listenerCount('drain')).toBe(0)
      expect(streamSocket.listenerCount('close')).toBe(0)
      expect(streamSocket.listenerCount('error')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps queued daemon stream writes by line count for tiny chunks', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher({
        maxBackpressuredBytes: 1024 * 1024,
        maxBackpressuredLines: 4
      })
      streamSocket.write.mockReturnValueOnce(false).mockReturnValue(true)

      batcher.enqueue('client-1', 'session-1', 'initial')
      vi.advanceTimersByTime(8)
      for (let index = 0; index < 20; index += 1) {
        batcher.enqueue('client-1', `session-${index + 2}`, `tiny-${index}`)
      }
      vi.advanceTimersByTime(8)
      streamSocket.write.mockClear()

      streamSocket.emit('drain')

      const written = streamSocket.write.mock.calls.map(([line]) => String(line))
      expect(written).toHaveLength(4)
      expect(written.join('\n')).not.toContain('tiny-0')
      expect(written.join('\n')).toContain('tiny-19')
    } finally {
      vi.useRealTimers()
    }
  })
})
