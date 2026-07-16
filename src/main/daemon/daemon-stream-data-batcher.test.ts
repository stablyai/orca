import { describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import { createNdjsonParser } from './ndjson'

function createBatcher(options?: ConstructorParameters<typeof DaemonStreamDataBatcher>[1]) {
  const streamSocket = {
    destroyed: false,
    writableLength: 0,
    write: vi.fn()
  } as unknown as Socket & { write: ReturnType<typeof vi.fn>; writableLength: number }
  const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket }), options)
  return { batcher, streamSocket }
}

function writtenData(streamSocket: { write: ReturnType<typeof vi.fn> }): string {
  return streamSocket.write.mock.calls
    .map(([line]) => {
      const parsed = JSON.parse(String(line)) as { payload?: { data?: string } }
      return parsed.payload?.data ?? ''
    })
    .join('')
}

type ParsedWrite = {
  event: string
  sessionId?: string
  payload?: { data?: string }
}

// A held pass arms a zero-payload data event whose kernel-flush callback
// refills the queue; it carries no content, so assertions about delivered
// output must ignore it.
function nonSentinelWrites(streamSocket: { write: ReturnType<typeof vi.fn> }): ParsedWrite[] {
  return streamSocket.write.mock.calls
    .map(([line]) => JSON.parse(String(line)) as ParsedWrite)
    .filter((message) => !(message.event === 'data' && (message.payload?.data ?? '') === ''))
}

describe('DaemonStreamDataBatcher', () => {
  it('coalesces background output before writing daemon stream events', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher()

      batcher.enqueue('client-1', 'session-1', 'a')
      batcher.enqueue('client-1', 'session-1', 'b')

      expect(streamSocket.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
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
      vi.advanceTimersByTime(2)
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
      vi.advanceTimersByTime(2)
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

      vi.advanceTimersByTime(2)
      expect(streamSocket.write).toHaveBeenCalledTimes(2)
      expect(String(streamSocket.write.mock.calls[1]?.[0])).toContain(
        '"sessionId":"session-background"'
      )
      expect(String(streamSocket.write.mock.calls[1]?.[0])).toContain(`"data":"${background}"`)
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds bulk output while the socket buffer is deep and resumes on the next flush', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher()
      const bulk = 'x'.repeat(64 * 1024)

      streamSocket.writableLength = 128 * 1024
      batcher.enqueue('client-1', 'session-bulk', bulk)
      vi.advanceTimersByTime(2)
      expect(nonSentinelWrites(streamSocket)).toHaveLength(0)
      expect(batcher.queuedCharsForClient('client-1')).toBe(bulk.length)

      // Socket drained (server routes 'drain' to flush): held bulk writes.
      streamSocket.writableLength = 0
      batcher.flush('client-1')
      expect(writtenData(streamSocket)).toBe(bulk)
      expect(batcher.queuedCharsForClient('client-1')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets interactive echo jump bulk held behind a deep socket', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher()

      streamSocket.writableLength = 128 * 1024
      batcher.enqueue('client-1', 'session-bulk', 'x'.repeat(64 * 1024))
      vi.advanceTimersByTime(2)
      expect(nonSentinelWrites(streamSocket)).toHaveLength(0)

      batcher.enqueue('client-1', 'session-typing', 'echo', {
        flushImmediately: true,
        flushMaxChars: 1024
      })
      const written = nonSentinelWrites(streamSocket)
      expect(written).toHaveLength(1)
      expect(written[0]?.sessionId).toBe('session-typing')
      // The bulk stays held — order across sessions has no contract, and the
      // deep socket is exactly what the echo must not queue behind.
      expect(batcher.queuedCharsForClient('client-1')).toBe(64 * 1024)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a small session write through the gate while a flooding session holds (per-session fairness)', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher()

      streamSocket.writableLength = 128 * 1024
      batcher.enqueue('client-1', 'session-flood', 'x'.repeat(256 * 1024))
      // Non-interactive small output (echo that missed the 100ms fast-path).
      batcher.enqueue('client-1', 'session-typing', 'echo-line')
      vi.advanceTimersByTime(2)

      // The flood holds; the tiny session's bytes must NOT wait behind it.
      const written = nonSentinelWrites(streamSocket)
      expect(written.some((m) => m.sessionId === 'session-typing')).toBe(true)
      expect(writtenData(streamSocket)).toContain('echo-line')
      expect(written.some((m) => m.sessionId === 'session-flood')).toBe(false)
      expect(batcher.queuedCharsForClient('client-1')).toBe(256 * 1024)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never reorders bytes within a session around the small-session bypass', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher()

      streamSocket.writableLength = 128 * 1024
      // Same session: big entry then (non-adjacent) small entry.
      batcher.enqueue('client-1', 'session-a', 'x'.repeat(256 * 1024))
      batcher.enqueue('client-1', 'session-b', 'other')
      batcher.enqueue('client-1', 'session-a', 'tail')
      vi.advanceTimersByTime(2)
      const written = streamSocket.write.mock.calls.map(([line]) => String(line)).join('')
      // session-a held its first entry, so its tail must be held too.
      expect(written).not.toContain('tail')

      streamSocket.writableLength = 0
      batcher.flush('client-1')
      expect(writtenData(streamSocket)).toContain('x'.repeat(64))
      // Full reassembly, in order, once drained.
      const aPayload = streamSocket.write.mock.calls
        .map(
          ([line]) =>
            JSON.parse(String(line)) as { sessionId?: string; payload?: { data?: string } }
        )
        .filter((m) => m.sessionId === 'session-a')
        .map((m) => m.payload?.data ?? '')
        .join('')
      expect(aPayload).toBe(`${'x'.repeat(256 * 1024)}tail`)
    } finally {
      vi.useRealTimers()
    }
  })

  it('slices oversized held entries so one write cannot re-deepen the socket unboundedly', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher()
      const bulk = 'y'.repeat(64 * 1024 + 5)

      batcher.enqueue('client-1', 'session-bulk', bulk)
      vi.advanceTimersByTime(2)
      // Two slices: 64K then the 5-char remainder; payload reassembles intact.
      expect(streamSocket.write).toHaveBeenCalledTimes(2)
      expect(writtenData(streamSocket)).toBe(bulk)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops mid-queue when a written slice is followed by a still-deep socket', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher()
      const first = 'a'.repeat(70 * 1024)

      batcher.enqueue('client-1', 'session-bulk', first)
      // First slice write fills the socket past the gate; the remainder holds.
      streamSocket.write.mockImplementation(() => {
        streamSocket.writableLength = 200 * 1024
        return false
      })
      vi.advanceTimersByTime(2)
      expect(nonSentinelWrites(streamSocket)).toHaveLength(1)
      expect(batcher.queuedCharsForClient('client-1')).toBe(first.length - 64 * 1024)

      streamSocket.writableLength = 0
      streamSocket.write.mockImplementation(() => true)
      batcher.flush('client-1')
      expect(writtenData(streamSocket)).toBe(first)
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes through the gate once held bulk exceeds the memory safety valve', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher()
      const huge = 'z'.repeat(32 * 1024 * 1024 + 1)

      streamSocket.writableLength = 128 * 1024
      batcher.enqueue('client-1', 'session-bulk', huge)
      vi.advanceTimersByTime(2)
      // Deep socket, but holding would exceed the valve: old write-through
      // behavior wins over bounded echo latency.
      expect(writtenData(streamSocket).length).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not split surrogate pairs at the bulk slice boundary', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher()
      // Position an astral char to straddle the 64K slice boundary.
      const bulk = `${'a'.repeat(64 * 1024 - 1)}😀${'b'.repeat(10)}`

      batcher.enqueue('client-1', 'session-bulk', bulk)
      vi.advanceTimersByTime(2)
      expect(writtenData(streamSocket)).toBe(bulk)
      for (const [line] of streamSocket.write.mock.calls) {
        expect(String(line)).not.toContain('�')
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('keep-tail drops a droppable session over the cap and delivers a gap before the kept tail', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher({
        isSessionDroppable: (sessionId) => sessionId === 'session-bg'
      })
      // Two enqueues that together cross the 1MB cap.
      batcher.enqueue('client-1', 'session-bg', 'a'.repeat(900 * 1024))
      batcher.enqueue('client-1', 'session-bg', 'b'.repeat(300 * 1024))
      expect(batcher.queuedCharsForClient('client-1')).toBe(512 * 1024)
      vi.advanceTimersByTime(2)

      const messages = streamSocket.write.mock.calls.map(
        ([line]) =>
          JSON.parse(String(line)) as {
            event: string
            payload: { data?: string; droppedChars?: number }
          }
      )
      expect(messages[0]?.event).toBe('dataGap')
      expect(messages[0]?.payload.droppedChars).toBe((900 + 300 - 512) * 1024)
      const delivered = messages
        .filter((m) => m.event === 'data')
        .map((m) => m.payload.data ?? '')
        .join('')
      expect(delivered.length).toBe(512 * 1024)
      // Keep-TAIL: the newest bytes survive.
      expect(delivered.endsWith('b'.repeat(300 * 1024))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('accounts every dropped char across repeated drops (gap sums + delivered = enqueued)', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher({ isSessionDroppable: () => true })
      // Deep socket: data holds; a gap entry (~100B) may still write through —
      // it always precedes the kept tail, so a second drop mints a second gap.
      streamSocket.writableLength = 128 * 1024
      batcher.enqueue('client-1', 'session-bg', 'a'.repeat(1024 * 1024 + 1))
      batcher.enqueue('client-1', 'session-bg', 'b'.repeat(600 * 1024))
      batcher.enqueue('client-1', 'session-bg', 'c'.repeat(600 * 1024))
      vi.advanceTimersByTime(2)

      streamSocket.writableLength = 0
      batcher.flush('client-1')
      const messages = streamSocket.write.mock.calls.map(
        ([line]) =>
          JSON.parse(String(line)) as {
            event: string
            payload: { data?: string; droppedChars?: number }
          }
      )
      const gapChars = messages
        .filter((m) => m.event === 'dataGap')
        .reduce((sum, m) => sum + (m.payload.droppedChars ?? 0), 0)
      const dataMessages = messages.filter((m) => m.event === 'data')
      const deliveredChars = dataMessages.reduce((sum, m) => sum + (m.payload.data?.length ?? 0), 0)
      expect(deliveredChars).toBeLessThanOrEqual(1024 * 1024)
      expect(gapChars + deliveredChars).toBe(1024 * 1024 + 1 + 1200 * 1024)
      // The newest bytes always survive.
      expect(dataMessages.at(-1)?.payload.data?.endsWith('c')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('salvages reply-eliciting query bytes out of dropped data', () => {
    vi.useFakeTimers()
    try {
      const dsr = '\x1b[6n'
      const { batcher, streamSocket } = createBatcher({
        isSessionDroppable: () => true,
        salvageDroppedData: (dropped) => (dropped.includes(dsr) ? dsr : '')
      })
      // The DSR probe sits in the oldest (dropped) region.
      batcher.enqueue('client-1', 'session-bg', `flood${dsr}${'x'.repeat(900 * 1024)}`)
      batcher.enqueue('client-1', 'session-bg', 'y'.repeat(300 * 1024))
      vi.advanceTimersByTime(2)

      const messages = streamSocket.write.mock.calls.map(
        ([line]) =>
          JSON.parse(String(line)) as {
            event: string
            payload: { data?: string; droppedChars?: number; sequenceChars?: number }
          }
      )
      expect(messages[0]?.event).toBe('dataGap')
      // The salvaged query rides right after the gap, before the kept tail.
      expect(messages[1]?.event).toBe('data')
      expect(messages[1]?.payload.data).toBe(dsr)
      expect(messages[1]?.payload.sequenceChars).toBe(0)
      const originalSequenceChars = messages.reduce(
        (sum, message) =>
          sum +
          (message.event === 'dataGap'
            ? (message.payload.sequenceChars ?? 0)
            : (message.payload.sequenceChars ?? message.payload.data?.length ?? 0)),
        0
      )
      expect(originalSequenceChars).toBe(`flood${dsr}${'x'.repeat(900 * 1024)}`.length + 300 * 1024)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shrinks keep-tails as more backgrounded sessions queue (global aggregate budget)', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher({ isSessionDroppable: () => true })
      streamSocket.writableLength = 128 * 1024 // deep socket: queues accumulate
      // 17 backgrounded sessions × 768KB — each below the single-session cap,
      // but a reveal would have to drain the ~13MB aggregate (measured 2.5s
      // hidden-restore). The global budget thins each to ~2MB/17 ≈ 120KB.
      for (let s = 0; s < 17; s++) {
        batcher.enqueue('client-1', `session-${s}`, '#'.repeat(768 * 1024))
      }
      const totalQueued = batcher.queuedCharsForClient('client-1')
      expect(totalQueued).toBeLessThan(3 * 1024 * 1024)
      // Every session still keeps at least a full screen of newest tail.
      streamSocket.writableLength = 0
      batcher.flush('client-1')
      const perSession = new Map<string, number>()
      for (const m of nonSentinelWrites(streamSocket)) {
        if (m.event === 'data' && m.sessionId) {
          perSession.set(
            m.sessionId,
            (perSession.get(m.sessionId) ?? 0) + (m.payload?.data?.length ?? 0)
          )
        }
      }
      for (let s = 0; s < 17; s++) {
        expect(perSession.get(`session-${s}`) ?? 0).toBeGreaterThanOrEqual(64 * 1024)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('never drops sessions that are not droppable', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher({ isSessionDroppable: () => false })
      const bulk = 'v'.repeat(2 * 1024 * 1024)
      batcher.enqueue('client-1', 'session-visible', bulk)
      vi.advanceTimersByTime(2)
      expect(writtenData(streamSocket)).toBe(bulk)
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers control events in byte order with the session data around them', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher()
      batcher.enqueue('client-1', 'session-1', 'before')
      batcher.enqueueControlEvent('client-1', 'session-1', {
        type: 'event',
        event: 'transientFact',
        sessionId: 'session-1',
        payload: { kind: 'bell' }
      })
      batcher.enqueue('client-1', 'session-1', 'after')
      vi.advanceTimersByTime(2)

      const messages = streamSocket.write.mock.calls.map(
        ([line]) => JSON.parse(String(line)) as { event: string; payload: { data?: string } }
      )
      expect(messages.map((m) => m.event)).toEqual(['data', 'transientFact', 'data'])
      expect(messages[0]?.payload.data).toBe('before')
      expect(messages[2]?.payload.data).toBe('after')
    } finally {
      vi.useRealTimers()
    }
  })

  it("holds a control event behind its session's held bulk (order latch)", () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher()
      streamSocket.writableLength = 128 * 1024
      batcher.enqueue('client-1', 'session-bulk', 'x'.repeat(64 * 1024))
      batcher.enqueueControlEvent('client-1', 'session-bulk', {
        type: 'event',
        event: 'sessionBackgroundMarker',
        sessionId: 'session-bulk',
        payload: { background: true }
      })
      vi.advanceTimersByTime(2)
      expect(nonSentinelWrites(streamSocket)).toHaveLength(0)

      streamSocket.writableLength = 0
      batcher.flush('client-1')
      expect(nonSentinelWrites(streamSocket).map((m) => m.event)).toEqual([
        'data',
        'sessionBackgroundMarker'
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers a held queued tail (data + facts, in order) once the socket drains', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher()
      streamSocket.writableLength = 128 * 1024
      batcher.enqueue('client-1', 'session-bg', 'x'.repeat(64 * 1024))
      batcher.enqueueControlEvent('client-1', 'session-bg', {
        type: 'event',
        event: 'transientFact',
        sessionId: 'session-bg',
        payload: { kind: 'bell' }
      })
      batcher.enqueue('client-1', 'session-bg', 'DONE')
      vi.advanceTimersByTime(2)

      // Reveal never discards: a finished program's last output must reach
      // main's model (restore reads it). The normal drain loop delivers it.
      streamSocket.writableLength = 0
      batcher.flush('client-1')
      expect(batcher.queuedCharsForClient('client-1')).toBe(0)
      const messages = nonSentinelWrites(streamSocket)
      expect(messages.map((m) => m.event)).toEqual(['data', 'transientFact', 'data'])
      expect(messages.at(-1)?.payload?.data).toBe('DONE')
    } finally {
      vi.useRealTimers()
    }
  })

  it('arms one kernel-flush refill sentinel per held pass and resumes without waiting for drain', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher()
      const flushCallbacks: (() => void)[] = []
      streamSocket.write.mockImplementation((_line: string, cb?: () => void) => {
        if (cb) {
          flushCallbacks.push(cb)
        }
        return true
      })

      streamSocket.writableLength = 128 * 1024
      batcher.enqueue('client-1', 'session-bulk', 'x'.repeat(64 * 1024))
      vi.advanceTimersByTime(2)
      // Held pass → exactly one sentinel armed; further held passes don't stack.
      expect(flushCallbacks).toHaveLength(1)
      batcher.flush('client-1')
      expect(flushCallbacks).toHaveLength(1)

      // Kernel flushed the in-flight bytes (socket now shallow): the sentinel
      // callback resumes the held bulk with no 'drain' event involved.
      streamSocket.writableLength = 0
      flushCallbacks[0]()
      expect(writtenData(streamSocket)).toBe('x'.repeat(64 * 1024))
      expect(batcher.queuedCharsForClient('client-1')).toBe(0)
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
      vi.advanceTimersByTime(2)
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
