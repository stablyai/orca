import { describe, expect, it, vi } from 'vitest'
import type { Socket } from 'net'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import { createNdjsonParser } from './ndjson'

function createBatcher(options?: ConstructorParameters<typeof DaemonStreamDataBatcher>[1]) {
  const streamSocket = {
    destroyed: false,
    write: vi.fn()
  } as unknown as Socket & { write: ReturnType<typeof vi.fn> }
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
})
