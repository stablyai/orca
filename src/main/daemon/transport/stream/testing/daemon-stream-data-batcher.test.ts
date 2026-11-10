import { describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import { DaemonStreamDataBatcher } from '../daemon-stream-data-batcher'
import { createNdjsonParser } from '../../../../../shared/main-process-ndjson-framer'

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

// Ignore empty refill frames when asserting delivered content.
function nonSentinelWrites(streamSocket: { write: ReturnType<typeof vi.fn> }): ParsedWrite[] {
  return streamSocket.write.mock.calls
    .map(([line]) => JSON.parse(String(line)) as ParsedWrite)
    .filter((message) => !(message.event === 'data' && (message.payload?.data ?? '') === ''))
}

describe('DaemonStreamDataBatcher', () => {
  it.each(['', 'x'])('accounts held transformed entries with %s payload data', (data) => {
    vi.useFakeTimers()
    let paused = false
    const { batcher, streamSocket } = createBatcher({
      onProducerBackpressureChanged: (_sessionId, value) => {
        paused = value
      }
    })
    try {
      streamSocket.writableLength = 128 * 1024
      batcher.enqueue('client-1', 'session-1', 'bulk'.repeat(16 * 1024))
      for (let seq = 1; seq <= 20_000 && !paused; seq++) {
        batcher.enqueue('client-1', 'session-1', data, { transformed: true, rawLength: 1, seq })
      }
      expect(paused).toBe(true)
      expect(batcher.queuedCharsForClient('client-1')).toBeLessThan(100 * 1024)
      batcher.clear()
      expect(paused).toBe(false)
    } finally {
      batcher.clear()
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

      streamSocket.writableLength = 0
      batcher.flush('client-1')
      expect(writtenData(streamSocket)).toBe(bulk)
      expect(batcher.queuedCharsForClient('client-1')).toBe(0)
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
      // Omit the interactive fast path to exercise small-session bypass.
      batcher.enqueue('client-1', 'session-typing', 'echo-line')
      vi.advanceTimersByTime(2)

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
      // Interleave another session to prevent adjacent entries from coalescing.
      batcher.enqueue('client-1', 'session-a', 'x'.repeat(256 * 1024))
      batcher.enqueue('client-1', 'session-b', 'other')
      batcher.enqueue('client-1', 'session-a', 'tail')
      vi.advanceTimersByTime(2)
      const written = streamSocket.write.mock.calls.map(([line]) => String(line)).join('')
      expect(written).not.toContain('tail')

      streamSocket.writableLength = 0
      batcher.flush('client-1')
      expect(writtenData(streamSocket)).toContain('x'.repeat(64))
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

  it('stops mid-queue when a written slice is followed by a still-deep socket', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher()
      const first = 'a'.repeat(70 * 1024)

      batcher.enqueue('client-1', 'session-bulk', first)
      // Fill the gate after the first slice so the remainder must be held.
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

  it('keep-tail drops a droppable session over the cap and delivers a gap before the kept tail', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher({
        isSessionDroppable: (sessionId) => sessionId === 'session-bg'
      })
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
      expect(delivered.endsWith('b'.repeat(300 * 1024))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('accounts every dropped char across repeated drops (gap sums + delivered = enqueued)', () => {
    vi.useFakeTimers()
    try {
      const { batcher, streamSocket } = createBatcher({ isSessionDroppable: () => true })
      // Hold gaps and data so repeated drops exercise queued gap accounting.
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
      streamSocket.writableLength = 128 * 1024
      // Keep every session below its individual cap while exceeding the shared tail budget.
      for (let s = 0; s < 17; s++) {
        batcher.enqueue('client-1', `session-${s}`, '#'.repeat(768 * 1024))
      }
      const totalQueued = batcher.queuedCharsForClient('client-1')
      expect(totalQueued).toBeLessThan(3 * 1024 * 1024)
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
      expect(flushCallbacks).toHaveLength(1)
      batcher.flush('client-1')
      expect(flushCallbacks).toHaveLength(1)

      // Complete the refill frame without a drain event to exercise callback-driven flushing.
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
