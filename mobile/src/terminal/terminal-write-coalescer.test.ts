import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTerminalWriteCoalescer,
  TERMINAL_WRITE_FLUSH_WINDOW_MS,
  TERMINAL_WRITE_MAX_PENDING_UNITS,
  TERMINAL_INTERACTIVE_WRITE_WINDOW_MS,
  TERMINAL_INTERACTIVE_WRITE_DURATION_MS
} from './terminal-write-coalescer'

function createDeliverySink() {
  const delivered: string[] = []
  return {
    delivered,
    deliver: (data: string) => {
      delivered.push(data)
    }
  }
}

describe('terminal write coalescer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('delivers the first write after construction synchronously (leading edge)', () => {
    vi.useFakeTimers()
    const sink = createDeliverySink()
    const coalescer = createTerminalWriteCoalescer(sink.deliver)

    coalescer.write('a')

    // Idle keystroke echo must never wait for a batching timer.
    expect(sink.delivered).toEqual(['a'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('takes the leading edge again after clear()', () => {
    vi.useFakeTimers()
    const sink = createDeliverySink()
    const coalescer = createTerminalWriteCoalescer(sink.deliver)

    coalescer.write('a')
    coalescer.write('b')
    coalescer.clear()
    coalescer.write('c')

    expect(sink.delivered).toEqual(['a', 'c'])
  })

  it('batches writes inside the trailing window preserving byte order', () => {
    vi.useFakeTimers()
    const sink = createDeliverySink()
    const coalescer = createTerminalWriteCoalescer(sink.deliver)

    coalescer.write('a')
    coalescer.write('b')
    coalescer.write('c')
    expect(sink.delivered).toEqual(['a'])

    vi.advanceTimersByTime(TERMINAL_WRITE_FLUSH_WINDOW_MS)
    expect(sink.delivered).toEqual(['a', 'bc'])
  })

  it('buffers a write landing inside the window even when the buffer is empty', () => {
    vi.useFakeTimers()
    const sink = createDeliverySink()
    const coalescer = createTerminalWriteCoalescer(sink.deliver)

    coalescer.write('a')
    vi.advanceTimersByTime(40)
    coalescer.write('b')
    expect(sink.delivered).toEqual(['a'])

    vi.advanceTimersByTime(TERMINAL_WRITE_FLUSH_WINDOW_MS - 40 - 1)
    expect(sink.delivered).toEqual(['a'])
    vi.advanceTimersByTime(1)
    expect(sink.delivered).toEqual(['a', 'b'])
  })

  it('flushes at most once per window for a sustained stream', () => {
    vi.useFakeTimers()
    const sink = createDeliverySink()
    const coalescer = createTerminalWriteCoalescer(sink.deliver)

    for (let i = 0; i < 200; i += 1) {
      coalescer.write(`c${i};`)
      // Check live timer count too; one timer per chunk could preserve flush counts while wasting work.
      expect(vi.getTimerCount()).toBeLessThanOrEqual(1)
      vi.advanceTimersByTime(5)
    }
    vi.runOnlyPendingTimers()

    const maxFlushes = Math.ceil((200 * 5) / TERMINAL_WRITE_FLUSH_WINDOW_MS) + 1
    expect(sink.delivered.length).toBeLessThanOrEqual(maxFlushes)
    expect(sink.delivered.join('')).toBe(Array.from({ length: 200 }, (_, i) => `c${i};`).join(''))
  })

  it('flushes within one window even when the wall clock jumps backwards mid-stream', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const sink = createDeliverySink()
    const coalescer = createTerminalWriteCoalescer(sink.deliver)

    coalescer.write('a')
    // Wall-clock corrections can jump backward; clamp timer remainders to avoid hours-long stream stalls.
    vi.setSystemTime(100_000 - 60 * 60 * 1000)
    coalescer.write('b')

    vi.advanceTimersByTime(TERMINAL_WRITE_FLUSH_WINDOW_MS)
    expect(sink.delivered).toEqual(['a', 'b'])
  })

  it('flushes immediately when the pending buffer exceeds the size cap', () => {
    vi.useFakeTimers()
    const sink = createDeliverySink()
    const coalescer = createTerminalWriteCoalescer(sink.deliver)

    coalescer.write('a')
    coalescer.write('x'.repeat(TERMINAL_WRITE_MAX_PENDING_UNITS + 1))

    expect(sink.delivered).toHaveLength(2)
    expect(sink.delivered[1]).toHaveLength(TERMINAL_WRITE_MAX_PENDING_UNITS + 1)
    expect(vi.getTimerCount()).toBe(0)
    vi.runOnlyPendingTimers()
    expect(sink.delivered).toHaveLength(2)
  })

  it('treats write("") as a no-op: no delivery, no buffer append, no timer', () => {
    vi.useFakeTimers()
    const sink = createDeliverySink()
    const coalescer = createTerminalWriteCoalescer(sink.deliver)

    coalescer.write('')
    expect(sink.delivered).toEqual([])
    expect(vi.getTimerCount()).toBe(0)

    coalescer.write('a')
    coalescer.write('')
    coalescer.write('b')
    vi.runOnlyPendingTimers()
    expect(sink.delivered).toEqual(['a', 'b'])
  })

  it('flushNow() delivers the joined pending buffer synchronously and cancels the timer', () => {
    vi.useFakeTimers()
    const sink = createDeliverySink()
    const coalescer = createTerminalWriteCoalescer(sink.deliver)

    coalescer.write('a')
    coalescer.write('b')
    coalescer.write('c')
    coalescer.flushNow()

    expect(sink.delivered).toEqual(['a', 'bc'])
    expect(vi.getTimerCount()).toBe(0)
    vi.runOnlyPendingTimers()
    expect(sink.delivered).toEqual(['a', 'bc'])
  })

  it('flushNow() with an empty buffer delivers nothing', () => {
    vi.useFakeTimers()
    const sink = createDeliverySink()
    const coalescer = createTerminalWriteCoalescer(sink.deliver)

    coalescer.flushNow()
    expect(sink.delivered).toEqual([])
  })

  it('clear() drops pending data without delivering and cancels the timer', () => {
    vi.useFakeTimers()
    const sink = createDeliverySink()
    const coalescer = createTerminalWriteCoalescer(sink.deliver)

    coalescer.write('a')
    coalescer.write('stale')
    coalescer.clear()

    expect(vi.getTimerCount()).toBe(0)
    vi.runOnlyPendingTimers()
    expect(sink.delivered).toEqual(['a'])
  })

  it('delivers nothing further after a flush is followed by clear()', () => {
    vi.useFakeTimers()
    const sink = createDeliverySink()
    const coalescer = createTerminalWriteCoalescer(sink.deliver)

    coalescer.write('a')
    coalescer.write('b')
    vi.advanceTimersByTime(TERMINAL_WRITE_FLUSH_WINDOW_MS)
    expect(sink.delivered).toEqual(['a', 'b'])

    coalescer.clear()
    vi.advanceTimersByTime(TERMINAL_WRITE_FLUSH_WINDOW_MS * 4)
    expect(sink.delivered).toEqual(['a', 'b'])
  })

  it('shortens an existing output wait when a scroll gesture arrives', () => {
    vi.useFakeTimers()
    const sink = createDeliverySink()
    const coalescer = createTerminalWriteCoalescer(sink.deliver)
    coalescer.write('first')
    vi.advanceTimersByTime(5)
    coalescer.write('response')
    vi.advanceTimersByTime(3)
    coalescer.markInteractive()
    vi.advanceTimersByTime(TERMINAL_INTERACTIVE_WRITE_WINDOW_MS - 8)
    expect(sink.delivered).toEqual(['first', 'response'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not postpone output when gestures repeat faster than one frame', () => {
    vi.useFakeTimers()
    const sink = createDeliverySink()
    const coalescer = createTerminalWriteCoalescer(sink.deliver)
    coalescer.markInteractive()
    coalescer.write('first')
    for (let i = 0; i < 8; i += 1) {
      coalescer.write(`${i}`)
      coalescer.markInteractive()
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(2)
    }
    expect(sink.delivered).toEqual(['first', '01234567'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns sustained unattended output to the original batching window', () => {
    vi.useFakeTimers()
    const sink = createDeliverySink()
    const coalescer = createTerminalWriteCoalescer(sink.deliver)
    coalescer.markInteractive()
    coalescer.write('gesture')
    vi.advanceTimersByTime(TERMINAL_INTERACTIVE_WRITE_DURATION_MS)
    coalescer.write('idle-leading')
    coalescer.write('idle-trailing')
    vi.advanceTimersByTime(TERMINAL_INTERACTIVE_WRITE_WINDOW_MS)
    expect(sink.delivered).toEqual(['gesture', 'idle-leading'])
    vi.advanceTimersByTime(TERMINAL_WRITE_FLUSH_WINDOW_MS - TERMINAL_INTERACTIVE_WRITE_WINDOW_MS)
    expect(sink.delivered).toEqual(['gesture', 'idle-leading', 'idle-trailing'])
  })

  it('clears interactive state and pending output when a document is replaced', () => {
    vi.useFakeTimers()
    const sink = createDeliverySink()
    const coalescer = createTerminalWriteCoalescer(sink.deliver)
    coalescer.markInteractive()
    coalescer.write('old')
    coalescer.write('stale')
    coalescer.clear()
    coalescer.write('new')
    coalescer.write('new-trailing')
    vi.advanceTimersByTime(TERMINAL_INTERACTIVE_WRITE_WINDOW_MS)
    expect(sink.delivered).toEqual(['old', 'new'])
    vi.advanceTimersByTime(TERMINAL_WRITE_FLUSH_WINDOW_MS - TERMINAL_INTERACTIVE_WRITE_WINDOW_MS)
    expect(sink.delivered).toEqual(['old', 'new', 'new-trailing'])
  })

  it('expires interactive batching on a monotonic clock after a wall-clock rollback', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const sink = createDeliverySink()
    const coalescer = createTerminalWriteCoalescer(sink.deliver)
    coalescer.markInteractive()
    vi.setSystemTime(0)
    vi.advanceTimersByTime(TERMINAL_INTERACTIVE_WRITE_DURATION_MS)
    coalescer.write('first')
    coalescer.write('second')
    vi.advanceTimersByTime(TERMINAL_INTERACTIVE_WRITE_WINDOW_MS)
    expect(sink.delivered).toEqual(['first'])
    vi.advanceTimersByTime(TERMINAL_WRITE_FLUSH_WINDOW_MS - TERMINAL_INTERACTIVE_WRITE_WINDOW_MS)
    expect(sink.delivered).toEqual(['first', 'second'])
  })
})
