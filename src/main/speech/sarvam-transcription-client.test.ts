import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { MockWebSocket } = vi.hoisted(() => {
  class MockWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    static instances: MockWebSocket[] = []

    readyState = MockWebSocket.OPEN
    bufferedAmount = 0
    sent: string[] = []
    closedWith: number | null = null
    url: string
    headers: Record<string, string>
    private listeners = new Map<string, Set<(...args: unknown[]) => void>>()

    constructor(url: string, options: { headers: Record<string, string> }) {
      this.url = url
      this.headers = options.headers
      MockWebSocket.instances.push(this)
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      const set = this.listeners.get(event) ?? new Set()
      set.add(listener)
      this.listeners.set(event, set)
      return this
    }

    once(event: string, listener: (...args: unknown[]) => void): this {
      const wrapped = (...args: unknown[]): void => {
        this.off(event, wrapped)
        listener(...args)
      }
      return this.on(event, wrapped)
    }

    off(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.get(event)?.delete(listener)
      return this
    }

    removeAllListeners(): this {
      this.listeners.clear()
      return this
    }

    emit(event: string, ...args: unknown[]): void {
      // Copy first: once() listeners remove themselves during iteration.
      for (const listener of Array.from(this.listeners.get(event) ?? [])) {
        listener(...args)
      }
    }

    send(data: string): void {
      this.sent.push(data)
    }

    close(code?: number): void {
      this.readyState = MockWebSocket.CLOSED
      this.closedWith = code ?? null
    }

    terminate(): void {
      this.readyState = MockWebSocket.CLOSED
    }
  }
  return { MockWebSocket }
})

vi.mock('ws', () => ({ WebSocket: MockWebSocket }))

import {
  SarvamTranscriptionSession,
  sanitizeSarvamTranscriptionErrorMessage
} from './sarvam-transcription-client'

type SttEvent = { type: string; text?: string; error?: string }

async function openSession(sink: (event: SttEvent) => void): Promise<{
  session: SarvamTranscriptionSession
  socket: InstanceType<typeof MockWebSocket>
}> {
  const session = new SarvamTranscriptionSession('sarvam-saaras-v3', () => 'secret-key', sink)
  const startPromise = session.start()
  const socket = MockWebSocket.instances.at(-1)!
  socket.emit('open')
  await startPromise
  return { session, socket }
}

beforeEach(() => {
  MockWebSocket.instances = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('sanitizeSarvamTranscriptionErrorMessage', () => {
  it('redacts the exact api key from provider errors', () => {
    expect(
      sanitizeSarvamTranscriptionErrorMessage('failed for key abc-123-secret', 'abc-123-secret')
    ).toBe('failed for key [redacted]')
  })

  it('maps authentication failures to a friendly message', () => {
    expect(sanitizeSarvamTranscriptionErrorMessage('invalid_api_key_error')).toBe(
      'Incorrect Sarvam API key provided.'
    )
  })
})

describe('SarvamTranscriptionSession', () => {
  it('connects with saaras:v3 auto-detect params and the subscription-key header', async () => {
    const { socket } = await openSession(vi.fn())

    expect(socket.url).toContain('model=saaras%3Av3')
    expect(socket.url).toContain('language-code=unknown')
    expect(socket.url).toContain('mode=transcribe')
    expect(socket.url).toContain('sample_rate=16000')
    // flush_signal must be enabled at connect time or stop()'s flush is ignored.
    expect(socket.url).toContain('flush_signal=true')
    expect(socket.url).toContain('high_vad_sensitivity=true')
    expect(socket.headers['api-subscription-key']).toBe('secret-key')
  })

  it('rejects start when the handshake returns an unexpected response', async () => {
    const session = new SarvamTranscriptionSession('sarvam-saaras-v3', () => 'secret-key', vi.fn())
    const startPromise = session.start()
    const socket = MockWebSocket.instances.at(-1)!
    socket.emit('unexpected-response', {}, { statusCode: 401 })

    await expect(startPromise).rejects.toThrow(/401/)
  })

  it('streams a batched audio frame once enough audio is buffered', async () => {
    const { session, socket } = await openSession(vi.fn())

    session.feedAudio(new Float32Array(4000).fill(0.1), 16000)

    const audioMessages = socket.sent.filter((m) => m.includes('"audio"'))
    expect(audioMessages).toHaveLength(1)
    const parsed = JSON.parse(audioMessages[0]) as {
      audio: { encoding: string; sample_rate: string; data: string }
    }
    expect(parsed.audio.encoding).toBe('audio/wav')
    expect(parsed.audio.sample_rate).toBe('16000')
    expect(parsed.audio.data.length).toBeGreaterThan(0)
  })

  it('emits each finalized segment as one final event', async () => {
    const sink = vi.fn()
    const { socket } = await openSession(sink)

    socket.emit('message', JSON.stringify({ type: 'data', data: { transcript: '  नमस्ते  ' } }))

    expect(sink).toHaveBeenCalledWith({ type: 'final', text: 'नमस्ते' })
  })

  it('surfaces server error messages through the sink', async () => {
    const sink = vi.fn()
    const { socket } = await openSession(sink)

    socket.emit('message', JSON.stringify({ type: 'error', data: { error: 'quota exceeded' } }))

    expect(sink).toHaveBeenCalledWith({ type: 'error', error: 'quota exceeded' })
  })

  it('flushes and closes the socket on stop', async () => {
    vi.useFakeTimers()
    const { session, socket } = await openSession(vi.fn())

    const stopPromise = session.stop()
    await vi.advanceTimersByTimeAsync(3000)
    await stopPromise

    expect(socket.sent.some((m) => m.includes('"flush"'))).toBe(true)
    expect(socket.closedWith).toBe(1000)
  })

  it('resolves stop shortly after the last flushed segment instead of waiting the full cap', async () => {
    vi.useFakeTimers()
    const sink = vi.fn()
    const { session, socket } = await openSession(sink)

    const stopPromise = session.stop()
    // A trailing finalized segment arrives after the flush.
    socket.emit('message', JSON.stringify({ type: 'data', data: { transcript: 'tail' } }))
    // Settling well under FLUSH_DRAIN_MS (3000ms) is enough to resolve stop.
    await vi.advanceTimersByTimeAsync(400)
    await stopPromise

    expect(sink).toHaveBeenCalledWith({ type: 'final', text: 'tail' })
    expect(socket.closedWith).toBe(1000)
  })

  it('tears down and surfaces an error on an abnormal server close', async () => {
    const sink = vi.fn()
    const { session, socket } = await openSession(sink)

    socket.emit('close', 1006, Buffer.from('gone'))

    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
    // The session is now closed: feeding more audio must not buffer or send into
    // the dead connection.
    const sentBefore = socket.sent.length
    session.feedAudio(new Float32Array(4000).fill(0.2), 16000)
    expect(socket.sent.length).toBe(sentBefore)
  })

  it('drops queued audio under backpressure instead of retaining it', async () => {
    vi.useFakeTimers()
    const { session, socket } = await openSession(vi.fn())

    socket.bufferedAmount = 2_000_000
    session.feedAudio(new Float32Array(4000).fill(0.2), 16000)
    // Backed up: the frame is dropped, not sent.
    expect(socket.sent.filter((m) => m.includes('"audio"'))).toHaveLength(0)

    // Relieve backpressure and stop. stop() force-drains; if the queue had been
    // retained it would resend now, but it was dropped, so no audio flushes.
    socket.bufferedAmount = 0
    socket.sent = []
    const stopPromise = session.stop()
    await vi.advanceTimersByTimeAsync(3000)
    await stopPromise

    expect(socket.sent.filter((m) => m.includes('"audio"'))).toHaveLength(0)
  })
})
