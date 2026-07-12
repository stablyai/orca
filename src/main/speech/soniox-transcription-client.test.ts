import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { SONIOX_WEBSOCKET_URL, SonioxTranscriptionSession } from './soniox-transcription-client'
import type { SonioxSocket } from './soniox-transcription-socket'

class FakeSocket extends EventEmitter implements SonioxSocket {
  readonly sent: (string | Buffer)[] = []
  readyState = 0
  bufferedAmount = 0

  send(data: string | Buffer): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.emit('close', 1000, Buffer.alloc(0))
  }

  open(): void {
    this.readyState = 1
    this.emit('open')
  }

  message(value: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(value)), false)
  }

  rawMessage(value: string): void {
    this.emit('message', Buffer.from(value), false)
  }

  fail(error: Error): void {
    this.emit('error', error)
  }
}

function makeSession() {
  const socket = new FakeSocket()
  const sink = vi.fn()
  const socketFactory = vi.fn(() => socket)
  const session = new SonioxTranscriptionSession(
    'soniox-stt-rt-v5',
    () => 'soniox-secret',
    sink,
    socketFactory
  )
  return { session, sink, socket, socketFactory }
}

describe('SonioxTranscriptionSession', () => {
  it('returns a rejected promise when reading the API key fails synchronously', async () => {
    const socketFactory = vi.fn(() => new FakeSocket())
    const session = new SonioxTranscriptionSession(
      'soniox-stt-rt-v5',
      () => {
        throw new Error('stored key is corrupt')
      },
      vi.fn(),
      socketFactory
    )
    let started: Promise<void> | undefined

    expect(() => {
      started = session.start()
    }).not.toThrow()

    await expect(started).rejects.toThrow('stored key is corrupt')
    expect(socketFactory).not.toHaveBeenCalled()
  })

  it('opens the official endpoint and sends raw PCM configuration first', async () => {
    const { session, socket, socketFactory } = makeSession()
    const started = session.start()

    socket.open()
    await started

    expect(socketFactory).toHaveBeenCalledWith(SONIOX_WEBSOCKET_URL)
    expect(JSON.parse(String(socket.sent[0]))).toEqual({
      api_key: 'soniox-secret',
      model: 'stt-rt-v5',
      audio_format: 'pcm_s16le',
      sample_rate: 16000,
      num_channels: 1,
      enable_endpoint_detection: true
    })
  })

  it('resamples audio and sends signed 16-bit little-endian binary frames', async () => {
    const { session, socket } = makeSession()
    const started = session.start()
    socket.open()
    await started

    session.feedAudio(new Float32Array([-1, 0, 1]), 16000)

    const audio = socket.sent[1]
    expect(Buffer.isBuffer(audio)).toBe(true)
    expect((audio as Buffer).readInt16LE(0)).toBe(-32768)
    expect((audio as Buffer).readInt16LE(2)).toBe(0)
    expect((audio as Buffer).readInt16LE(4)).toBe(32767)
  })

  it('resamples a 48 kHz chunk to 16 kHz before sending it', async () => {
    const { session, socket } = makeSession()
    const started = session.start()
    socket.open()
    await started

    session.feedAudio(new Float32Array(480), 48000)

    expect(socket.sent[1]).toHaveLength(320)
  })

  it('does not send empty audio because Soniox treats it as end-of-stream', async () => {
    const { session, socket } = makeSession()
    const started = session.start()
    socket.open()
    await started

    session.feedAudio(new Float32Array(), 16000)

    expect(socket.sent).toHaveLength(1)
  })

  it('fails with a bounded error when queued audio exceeds 30 seconds', async () => {
    const { session, sink, socket } = makeSession()
    const started = session.start()
    socket.open()
    await started

    expect(() => session.feedAudio(new Float32Array(31 * 16000), 16000)).toThrow(
      'Soniox audio queue exceeded 30 seconds'
    )
    expect(sink).toHaveBeenCalledWith({
      type: 'error',
      error: 'Soniox audio queue exceeded 30 seconds'
    })
  })

  it('queues pre-open audio and sends it only after the configuration frame', async () => {
    const { session, socket } = makeSession()
    const started = session.start()

    session.feedAudio(new Float32Array([0.5]), 16000)
    expect(socket.sent).toHaveLength(0)

    socket.open()
    await started

    expect(typeof socket.sent[0]).toBe('string')
    expect(Buffer.isBuffer(socket.sent[1])).toBe(true)
  })

  it('appends final tokens once and replaces non-final text on each response', async () => {
    const { session, sink, socket } = makeSession()
    const started = session.start()
    socket.open()
    await started

    socket.message({
      tokens: [
        { text: 'How', is_final: true },
        { text: ' are', is_final: false }
      ]
    })
    socket.message({
      tokens: [
        { text: ' are', is_final: true },
        { text: ' you?', is_final: false }
      ]
    })

    expect(sink.mock.calls).toEqual([
      [{ type: 'final', text: 'How', preserveExactText: true }],
      [{ type: 'partial', text: ' are' }],
      [{ type: 'final', text: ' are', preserveExactText: true }],
      [{ type: 'partial', text: ' you?' }]
    ])
  })

  it('preserves punctuation, whitespace, and CJK token text exactly', async () => {
    const { session, sink, socket } = makeSession()
    const started = session.start()
    socket.open()
    await started

    socket.message({
      tokens: [
        { text: 'Hello', is_final: true },
        { text: ',', is_final: true },
        { text: ' ', is_final: true },
        { text: '世界', is_final: true }
      ]
    })

    expect(sink).toHaveBeenCalledWith({
      type: 'final',
      text: 'Hello, 世界',
      preserveExactText: true
    })
  })

  it('sends an empty text frame and waits for the finished response', async () => {
    const { session, sink, socket } = makeSession()
    const started = session.start()
    socket.open()
    await started

    const finishing = session.finish()
    // Why: empty text (not empty binary) is the end-of-stream signal Soniox
    // acknowledges from the Node `ws` client in live sessions.
    expect(socket.sent.at(-1)).toBe('')
    socket.message({
      tokens: [{ text: 'Done.', is_final: true }],
      finished: true
    })

    await expect(finishing).resolves.toBe('')
    expect(sink).toHaveBeenCalledWith({
      type: 'final',
      text: 'Done.',
      preserveExactText: true
    })
  })

  it('makes repeated finish calls share one end-of-stream frame', async () => {
    const { session, socket } = makeSession()
    const started = session.start()
    socket.open()
    await started

    const first = session.finish()
    const second = session.finish()
    expect(socket.sent.filter((item) => item === '')).toHaveLength(1)
    socket.message({ tokens: [], finished: true })

    await expect(Promise.all([first, second])).resolves.toEqual(['', ''])
  })

  it('times out a connection that never opens', async () => {
    vi.useFakeTimers()
    try {
      const { session, sink, socket } = makeSession()
      const started = session.start()
      const outcome = expect(started).rejects.toThrow('Soniox connection timed out while starting')

      await vi.advanceTimersByTimeAsync(60_000)
      await outcome

      expect(sink).not.toHaveBeenCalled()
      expect(socket.eventNames()).toEqual([])
      socket.open()
      expect(socket.sent).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes without sending when canceled while still connecting', async () => {
    const { session, socket } = makeSession()
    const started = session.start()
    const startOutcome = expect(started).rejects.toThrow(
      'Soniox connection closed before transcription started'
    )

    await expect(session.finish()).resolves.toBe('')

    expect(socket.readyState).toBe(3)
    expect(socket.sent).toHaveLength(0)
    await startOutcome
    expect(socket.eventNames()).toEqual([])
  })

  it('filters endpoint and finalize control tokens from user-visible text', async () => {
    const { session, sink, socket } = makeSession()
    const started = session.start()
    socket.open()
    await started

    socket.message({
      tokens: [
        { text: 'Hello', is_final: true },
        { text: '<end>', is_final: true },
        { text: '<fin>', is_final: true }
      ]
    })

    expect(sink).toHaveBeenCalledWith({
      type: 'final',
      text: 'Hello',
      preserveExactText: true
    })
    expect(sink.mock.calls.flat().some((event) => String(event.text).includes('<'))).toBe(false)
  })

  it('sends keepalive during a silent open session and stops it while finishing', async () => {
    vi.useFakeTimers()
    try {
      const { session, socket } = makeSession()
      const started = session.start()
      socket.open()
      await started

      await vi.advanceTimersByTimeAsync(10_000)
      expect(socket.sent).toContain(JSON.stringify({ type: 'keepalive' }))

      const finishing = session.finish()
      const countAfterFinish = socket.sent.length
      await vi.advanceTimersByTimeAsync(10_000)
      expect(socket.sent).toHaveLength(countAfterFinish)
      socket.message({ tokens: [], finished: true })
      await finishing
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets keepalive after audio and clears it after an error', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { session, socket } = makeSession()
      const started = session.start()
      socket.open()
      await started

      await vi.advanceTimersByTimeAsync(9_000)
      session.feedAudio(new Float32Array([0.25]), 16000)
      await vi.advanceTimersByTimeAsync(9_999)
      expect(socket.sent).not.toContain(JSON.stringify({ type: 'keepalive' }))

      socket.fail(new Error('network down'))
      const sendsAfterError = socket.sent.length
      await vi.advanceTimersByTimeAsync(20_000)
      expect(socket.sent).toHaveLength(sendsAfterError)
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('waits for WebSocket backpressure before sending queued audio', async () => {
    vi.useFakeTimers()
    try {
      const { session, socket } = makeSession()
      const started = session.start()
      socket.open()
      await started
      socket.bufferedAmount = 2 * 1024 * 1024

      session.feedAudio(new Float32Array([0.25]), 16000)
      expect(socket.sent).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(99)
      expect(socket.sent).toHaveLength(1)

      socket.bufferedAmount = 0
      await vi.advanceTimersByTimeAsync(1)
      expect(Buffer.isBuffer(socket.sent[1])).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out finish when the server never sends its finished marker', async () => {
    vi.useFakeTimers()
    try {
      const { session, socket } = makeSession()
      const started = session.start()
      socket.open()
      await started
      const finishing = session.finish()
      const outcome = expect(finishing).rejects.toThrow(
        'Soniox transcription timed out while finishing'
      )

      await vi.advanceTimersByTimeAsync(60_000)

      await outcome
      expect(socket.readyState).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('redacts credentials from server errors before reporting them', async () => {
    const { session, sink, socket } = makeSession()
    const started = session.start()
    socket.open()
    await started

    socket.message({
      tokens: [],
      error_type: 'unauthenticated',
      error_message: 'Incorrect API key provided: soniox-secret',
      request_id: 'request-123'
    })

    expect(sink).toHaveBeenCalledWith({
      type: 'error',
      error: 'Soniox authentication failed. Check the configured API key. Request ID: request-123.'
    })
    expect(JSON.stringify(sink.mock.calls)).not.toContain('soniox-secret')
  })

  it('sanitizes WebSocket library errors before reporting them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { session, sink, socket } = makeSession()
    const started = session.start()
    socket.open()
    await started

    socket.fail(new Error('socket rejected Bearer soniox-secret'))

    expect(sink).toHaveBeenCalledWith({
      type: 'error',
      error: 'Soniox connection failed.'
    })
    expect(JSON.stringify(sink.mock.calls)).not.toContain('soniox-secret')
    expect(warn).toHaveBeenCalledWith('[speech] Soniox WebSocket error', {
      detail: 'socket rejected Bearer [redacted]'
    })
    warn.mockRestore()
  })

  it('reports malformed JSON and removes socket listeners on close', async () => {
    const { session, sink, socket } = makeSession()
    const started = session.start()
    socket.open()
    await started

    socket.rawMessage('{not json')

    expect(sink).toHaveBeenCalledWith({
      type: 'error',
      error: 'Soniox transcription returned an invalid response'
    })
    expect(socket.eventNames()).toEqual([])
  })

  it('reports an unexpected server close as a stable error', async () => {
    const { session, sink, socket } = makeSession()
    const started = session.start()
    socket.open()
    await started

    socket.close()

    expect(sink).toHaveBeenCalledWith({
      type: 'error',
      error: 'Soniox connection closed unexpectedly'
    })
    expect(socket.eventNames()).toEqual([])
  })
})
