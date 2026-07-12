import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  SONIOX_WEBSOCKET_URL,
  SonioxTranscriptionSession,
  type SonioxSocket
} from './soniox-transcription-client'

class FakeSocket extends EventEmitter implements SonioxSocket {
  readonly sent: (string | Buffer)[] = []
  readyState = 0

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
      [{ type: 'final', text: 'How' }],
      [{ type: 'partial', text: ' are' }],
      [{ type: 'final', text: ' are' }],
      [{ type: 'partial', text: ' you?' }]
    ])
  })

  it('sends an empty binary frame and waits for the finished response', async () => {
    const { session, sink, socket } = makeSession()
    const started = session.start()
    socket.open()
    await started

    const finishing = session.finish()
    expect(socket.sent.at(-1)).toEqual(Buffer.alloc(0))
    socket.message({
      tokens: [{ text: 'Done.', is_final: true }],
      finished: true
    })

    await expect(finishing).resolves.toBe('')
    expect(sink).toHaveBeenCalledWith({ type: 'final', text: 'Done.' })
  })

  it('makes repeated finish calls share one end-of-stream frame', async () => {
    const { session, socket } = makeSession()
    const started = session.start()
    socket.open()
    await started

    const first = session.finish()
    const second = session.finish()
    expect(socket.sent.filter((item) => Buffer.isBuffer(item) && item.length === 0)).toHaveLength(1)
    socket.message({ tokens: [], finished: true })

    await expect(Promise.all([first, second])).resolves.toEqual(['', ''])
  })

  it('times out a connection that never opens', async () => {
    vi.useFakeTimers()
    try {
      const { session } = makeSession()
      const started = session.start()
      const outcome = expect(started).rejects.toThrow('Soniox connection timed out while starting')

      await vi.advanceTimersByTimeAsync(60_000)
      await outcome
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

    expect(sink).toHaveBeenCalledWith({ type: 'final', text: 'Hello' })
    expect(sink).not.toHaveBeenCalledWith({ type: 'final', text: expect.stringContaining('<') })
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
    const { session, sink, socket } = makeSession()
    const started = session.start()
    socket.open()
    await started

    socket.fail(new Error('socket rejected Bearer soniox-secret'))

    expect(sink).toHaveBeenCalledWith({
      type: 'error',
      error: 'Soniox connection failed: socket rejected Bearer [redacted]'
    })
    expect(JSON.stringify(sink.mock.calls)).not.toContain('soniox-secret')
  })
})
