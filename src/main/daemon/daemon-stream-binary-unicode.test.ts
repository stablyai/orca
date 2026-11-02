import { describe, expect, it } from 'vitest'
import {
  createBinaryStreamFrameReader,
  encodeBinaryStreamDataFrame
} from './daemon-stream-binary-framing'
import { streamFramesFor, type StreamWriteChunk } from './daemon-stream-data-split'
import { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'
import type { DaemonEvent } from './types'

function reader() {
  const events: DaemonEvent[] = []
  const fatal: Error[] = []
  const frames = createBinaryStreamFrameReader(
    (event) => events.push(event),
    (error) => fatal.push(error)
  )
  return {
    events,
    fatal,
    feed(chunk: StreamWriteChunk) {
      frames.feed(Buffer.from(chunk))
    },
    data() {
      return events.map((event) => (event.event === 'data' ? event.payload.data : '')).join('')
    }
  }
}

describe('binary stream UTF-16 preservation', () => {
  it.each(['\ud83d', '\ude00', '\ud83d\ude00', '\ufffd', '\ud83da\ude00'])(
    'preserves exact code units for %j',
    (data) => {
      const received = reader()
      received.feed(encodeBinaryStreamDataFrame('session', data, { seq: 7, rawLength: 3 }))
      expect(received.fatal).toEqual([])
      expect(received.events).toEqual([
        {
          type: 'event',
          event: 'data',
          sessionId: 'session',
          payload: { data, seq: 7, rawLength: 3 }
        }
      ])
    }
  )

  it('keeps JSON fallback frames inside the byte cap and preserves sequence positions', () => {
    const data = '\ud83d\x1b[32m"quoted"\n'.repeat(1000)
    const received = reader()
    const frames: Buffer[] = []
    streamFramesFor('binary-v1').data(
      { write: (chunk) => frames.push(Buffer.from(chunk)) },
      'session',
      data,
      1024,
      data.length,
      data.length
    )
    for (const frame of frames) {
      expect(frame.length).toBeLessThanOrEqual(1024)
      received.feed(frame)
    }
    expect(received.fatal).toEqual([])
    expect(received.data()).toBe(data)
    let endSeq = 0
    for (const event of received.events) {
      if (event.event !== 'data') {
        throw new Error('expected data')
      }
      endSeq += event.payload.data.length
      expect(event.payload.seq).toBe(endSeq)
      expect(event.payload.rawLength).toBe(event.payload.data.length)
    }
  })

  it('preserves Unicode split by the real shell recovery barrier', async () => {
    const received = reader()
    const data = `\x1b[?1049hTUI\x1b]133;D;😀${'x'.repeat(4094)}\x07prompt`
    const barrier = new TerminalShellRecoveryBarrier({
      confirmShellForeground: async () => false,
      isAlive: () => true,
      release: (emission) => {
        streamFramesFor('binary-v1').data(
          { write: (chunk) => received.feed(chunk) },
          'session',
          emission.data,
          16 * 1024 * 1024,
          emission.rawEndSeq - emission.rawStartSeq,
          emission.rawEndSeq,
          emission.transformed
        )
      }
    })
    try {
      barrier.accept({ data, rawStartSeq: 0, rawEndSeq: data.length, transformed: false })
      await barrier.idle()
      expect(received.fatal).toEqual([])
      expect(received.data()).toBe(data)
    } finally {
      barrier.dispose()
    }
  })
})
