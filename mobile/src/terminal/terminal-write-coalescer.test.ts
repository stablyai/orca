import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTerminalWriteCoalescer,
  TERMINAL_WRITE_FLUSH_WINDOW_MS,
  TERMINAL_WRITE_MAX_PENDING_UNITS
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

    // Why: interactive latency invariant — keystroke echo on an idle terminal
    // must not wait for any timer.
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

    // The trailing timer covers only the remainder of the window.
    vi.advanceTimersByTime(TERMINAL_WRITE_FLUSH_WINDOW_MS - 40 - 1)
    expect(sink.delivered).toEqual(['a'])
    vi.advanceTimersByTime(1)
    expect(sink.delivered).toEqual(['a', 'b'])
  })

  it('flushes at most once per window for a sustained stream', () => {
    vi.useFakeTimers()
    const sink = createDeliverySink()
    const coalescer = createTerminalWriteCoalescer(sink.deliver)

    // 200 chunks at 5ms cadence ≈ the desktop runtime's flush rate on a busy PTY.
    for (let i = 0; i < 200; i += 1) {
      coalescer.write(`c${i};`)
      // Why: a regression arming one timer per chunk (instead of per window) would
      // still flush once per window — bound the live timer count, not just flushes.
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
    // Why: Date.now() is not monotonic (NTP/timezone correction); an unclamped
    // timer remainder would span the whole jump and stall the stream for hours.
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
})
