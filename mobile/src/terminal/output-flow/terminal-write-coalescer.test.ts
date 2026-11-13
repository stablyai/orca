import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalWriteCoalescer } from './terminal-write-coalescer'

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

  it('batches writes inside the trailing window preserving byte order', () => {
    vi.useFakeTimers()
    const sink = createDeliverySink()
    const coalescer = createTerminalWriteCoalescer(sink.deliver)

    coalescer.write('a')
    coalescer.write('b')
    coalescer.write('c')
    expect(sink.delivered).toEqual(['a'])

    vi.advanceTimersByTime(48)
    expect(sink.delivered).toEqual(['a', 'bc'])
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

    vi.advanceTimersByTime(48)
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
    vi.runOnlyPendingTimers()
    expect(sink.delivered).toEqual(['a', 'bc'])
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
      vi.advanceTimersByTime(2)
    }
    expect(sink.delivered).toEqual(['first', '01234567'])
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
    vi.advanceTimersByTime(16)
    expect(sink.delivered).toEqual(['old', 'new'])
    vi.advanceTimersByTime(32)
    expect(sink.delivered).toEqual(['old', 'new', 'new-trailing'])
  })
})
