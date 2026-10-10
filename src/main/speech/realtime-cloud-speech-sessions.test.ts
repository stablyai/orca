import { beforeEach, describe, expect, it, vi } from 'vitest'

const { FakeWebSocket } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  class HoistedFakeWebSocket extends EventEmitter {
    readonly OPEN = 1
    static instances: HoistedFakeWebSocket[] = []
    static constructError: Error | null = null
    readyState = 0
    bufferedAmount = 0
    sent: (string | Buffer)[] = []
    closedWith: number | 'terminated' | null = null

    constructor(
      readonly url: string | URL,
      readonly headers?: Record<string, string>
    ) {
      super()
      if (HoistedFakeWebSocket.constructError) {
        throw HoistedFakeWebSocket.constructError
      }
      HoistedFakeWebSocket.instances.push(this)
    }

    send(data: string | Buffer): void {
      this.sent.push(data)
    }

    close(code: number): void {
      this.closedWith = code
      this.readyState = 3
    }

    terminate(): void {
      this.closedWith = 'terminated'
      this.readyState = 3
    }

    open(): void {
      this.readyState = 1
      this.emit('open')
    }

    receive(message: unknown): void {
      this.emit('message', Buffer.from(JSON.stringify(message)), false)
    }

    jsonFrames(): Record<string, unknown>[] {
      return this.sent
        .filter((item): item is string => typeof item === 'string' && item !== '')
        .map((item) => JSON.parse(item))
    }
  }
  return { FakeWebSocket: HoistedFakeWebSocket }
})

vi.mock('./cloud-speech-websocket', () => ({
  openProviderWebSocket: (url: string | URL, headers?: Record<string, string>) =>
    new FakeWebSocket(url, headers)
}))

import { getCatalogModel } from './model-catalog'
import { createCloudSpeechSession } from './cloud-speech-session-factory'
import {
  MAX_REALTIME_BUFFERED_BYTES,
  REALTIME_ACCEPT_TIMEOUT_MS,
  REALTIME_FINISH_TIMEOUT_MS
} from './realtime-cloud-speech-session'

function start(modelId: string, language?: string) {
  const manifest = getCatalogModel(modelId)
  if (!manifest) {
    throw new Error(`missing ${modelId}`)
  }
  const sink = vi.fn()
  const session = createCloudSpeechSession(manifest, {
    readApiKey: () => 'rt-key',
    language,
    sink
  })
  const socket = FakeWebSocket.instances.at(-1)
  if (!socket) {
    throw new Error('socket not opened')
  }
  return { session, sink, socket }
}

const SPEECH = new Float32Array(1600).fill(0.2)

beforeEach(() => {
  FakeWebSocket.instances = []
  FakeWebSocket.constructError = null
})

describe('Soniox realtime session', () => {
  it('authenticates with a Bearer header and buffers audio until the socket opens', async () => {
    const { session, sink, socket } = start('soniox-stt-rt-v5', 'uk')
    expect(socket.headers?.Authorization).toBe('Bearer rt-key')
    session.feedAudio(SPEECH, 16_000)
    expect(socket.sent).toHaveLength(0)

    socket.open()

    expect(socket.jsonFrames()[0]).not.toHaveProperty('api_key')
    expect(JSON.stringify(socket.jsonFrames())).not.toContain('rt-key')
    expect(socket.jsonFrames()[0]).toMatchObject({
      model: 'stt-rt-v5',
      audio_format: 'pcm_s16le',
      sample_rate: 16000,
      language_hints: ['uk']
    })
    expect(Buffer.isBuffer(socket.sent[1])).toBe(true)

    socket.receive({
      tokens: [
        { text: 'Hel', is_final: true },
        { text: 'lo wor', is_final: false }
      ]
    })
    socket.receive({
      tokens: [
        { text: 'lo', is_final: true },
        { text: ' world', is_final: false }
      ]
    })
    expect(sink).toHaveBeenLastCalledWith({ type: 'partial', text: 'Hello world' })

    const finished = session.finish()
    expect(socket.sent.at(-1)).toBe('')
    socket.receive({
      tokens: [
        { text: ' world', is_final: true },
        { text: '<fin>', is_final: true }
      ]
    })
    socket.receive({ finished: true })

    await expect(finished).resolves.toBe('Hello world')
    expect(socket.closedWith).toBe(1000)
    expect(sink).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'final' }))
  })

  it('reports provider errors through the sink', () => {
    const { sink, socket } = start('soniox-stt-rt-v5')
    socket.open()

    socket.receive({ error_code: 401, error_message: 'Invalid API key rt-key-abcdef1234567890' })

    expect(sink).toHaveBeenCalledWith({ type: 'error', error: expect.stringContaining('401') })
    expect(JSON.stringify(sink.mock.calls)).not.toContain('rt-key-abcdef1234567890')
    expect(socket.closedWith).toBe(1000)
  })

  it.each([
    ['a token without text', { tokens: [{ text: null, is_final: false }] }],
    ['a token without is_final', { tokens: [{ text: 'hi' }] }],
    ['a non-array tokens field', { tokens: 'hi' }],
    ['a non-boolean finished flag', { finished: 'yes' }]
  ])('fails on %s instead of dropping the in-progress text', (_name, frame) => {
    const { session, sink, socket } = start('soniox-stt-rt-v5')
    session.feedAudio(SPEECH, 16_000)
    socket.open()
    socket.receive({ tokens: [{ text: 'Hello', is_final: false }] })

    socket.receive(frame)

    expect(sink).toHaveBeenLastCalledWith({
      type: 'error',
      error: 'Soniox returned an invalid realtime response.'
    })
    expect(sink).not.toHaveBeenCalledWith({ type: 'partial', text: '' })
    expect(socket.closedWith).toBe(1000)
  })

  it('maps a rejected handshake to a key error without echoing the key', () => {
    const { sink, socket } = start('soniox-stt-rt-v5')

    socket.emit('unexpected-response', { destroy: vi.fn() }, { statusCode: 401 })

    expect(sink.mock.calls).toEqual([
      [{ type: 'error', error: 'Soniox rejected the API key (401).' }]
    ])
  })

  it('rejects creation without echoing a key the header cannot carry', () => {
    FakeWebSocket.constructError = new Error('Invalid header value: "Bearer sk-soniox-secret"')
    const manifest = getCatalogModel('soniox-stt-rt-v5')
    if (!manifest) {
      throw new Error('missing soniox-stt-rt-v5')
    }

    expect(() =>
      createCloudSpeechSession(manifest, { readApiKey: () => 'sk-soniox-secret', sink: vi.fn() })
    ).toThrow('API key contains invalid characters.')
  })
})

describe('ElevenLabs realtime session', () => {
  it('sends the key as a header and waits for session_started before audio', async () => {
    const { session, sink, socket } = start('elevenlabs-scribe-v2-realtime', 'en')
    expect(String(socket.url)).toContain('model_id=scribe_v2_realtime')
    expect(String(socket.url)).toContain('commit_strategy=manual')
    expect(String(socket.url)).toContain('language_code=en')
    expect(socket.headers?.['xi-api-key']).toBe('rt-key')

    session.feedAudio(SPEECH, 16_000)
    socket.open()
    expect(socket.sent).toHaveLength(0)
    socket.receive({ message_type: 'session_started' })
    expect(socket.jsonFrames()[0]).toMatchObject({
      message_type: 'input_audio_chunk',
      commit: false,
      sample_rate: 16000
    })

    socket.receive({ message_type: 'partial_transcript', text: 'good morning' })
    expect(sink).toHaveBeenLastCalledWith({ type: 'partial', text: 'good morning' })

    const finished = session.finish()
    expect(socket.jsonFrames().at(-1)).toMatchObject({ audio_base_64: '', commit: true })
    socket.receive({ message_type: 'committed_transcript', text: 'Good morning.' })

    await expect(finished).resolves.toBe('Good morning.')
  })

  it('fails on auth errors', () => {
    const { sink, socket } = start('elevenlabs-scribe-v2-realtime')
    socket.open()

    socket.receive({ message_type: 'auth_error', error: 'Invalid API key' })

    expect(sink).toHaveBeenCalledWith({
      type: 'error',
      error: 'ElevenLabs auth error: Invalid API key'
    })
  })

  it.each(['invalid_request', 'queue_overflow', 'insufficient_audio_activity'])(
    'fails on %s during finish and keeps committed text',
    async (messageType) => {
      const { session, sink, socket } = start('elevenlabs-scribe-v2-realtime')
      socket.open()
      socket.receive({ message_type: 'session_started' })
      session.feedAudio(SPEECH, 16_000)
      socket.receive({ message_type: 'committed_transcript', text: 'Kept.' })

      const finished = session.finish()
      socket.receive({ message_type: messageType, error: 'went wrong' })

      await expect(finished).resolves.toBe('Kept.')
      expect(sink).toHaveBeenCalledWith({
        type: 'error',
        error: `ElevenLabs ${messageType.replace(/_/g, ' ')}: went wrong`
      })
    }
  )
})

describe('realtime transcript frame validation', () => {
  it.each([
    { message_type: 'committed_transcript', text: null },
    { message_type: 'committed_transcript_with_timestamps' },
    { message_type: 'partial_transcript', text: 42 }
  ])('fails on a malformed ElevenLabs frame %o and keeps the partial', async (frame) => {
    const { session, sink, socket } = start('elevenlabs-scribe-v2-realtime')
    socket.open()
    socket.receive({ message_type: 'session_started' })
    session.feedAudio(SPEECH, 16_000)
    socket.receive({ message_type: 'partial_transcript', text: 'still here' })

    socket.receive(frame)

    expect(sink).toHaveBeenLastCalledWith({
      type: 'error',
      error: 'ElevenLabs returned an invalid realtime response.'
    })
    await expect(session.finish()).resolves.toBe('still here')
  })

  it.each([
    { type: 'Results', is_final: true, channel: {} },
    { type: 'Results', is_final: true, channel: { alternatives: [] } },
    { type: 'Results', is_final: true, channel: { alternatives: [{ transcript: null }] } },
    { type: 'Results', is_final: 'yes', channel: { alternatives: [{ transcript: 'x' }] } }
  ])('fails on a malformed Deepgram Results frame %o and keeps the interim', async (frame) => {
    const { session, sink, socket } = start('deepgram-nova-3')
    socket.open()
    session.feedAudio(SPEECH, 16_000)
    socket.receive(results('interim words', false))

    socket.receive(frame)

    expect(sink).toHaveBeenLastCalledWith({
      type: 'error',
      error: 'Deepgram returned an invalid realtime response.'
    })
    await expect(session.finish()).resolves.toBe('interim words')
  })

  it('ignores Deepgram metadata frames', () => {
    const { sink, socket } = start('deepgram-nova-3')
    socket.open()

    socket.receive({ type: 'Metadata', request_id: 'r-1' })
    socket.receive({ type: 'SpeechStarted' })

    expect(sink).not.toHaveBeenCalled()
  })
})

describe('Deepgram realtime session', () => {
  it('uses Token auth, multilingual by default, and flushes with CloseStream', async () => {
    const { session, sink, socket } = start('deepgram-nova-3')
    expect(String(socket.url)).toContain('model=nova-3')
    expect(String(socket.url)).toContain('language=multi')
    expect(socket.headers?.Authorization).toBe('Token rt-key')

    socket.open()
    session.feedAudio(SPEECH, 16_000)
    socket.receive(results('first part', true))
    socket.receive(results('second', false))
    expect(sink).toHaveBeenLastCalledWith({ type: 'partial', text: 'first part second' })

    const finished = session.finish()
    expect(socket.jsonFrames().at(-1)).toEqual({ type: 'CloseStream' })
    socket.receive(results('second part', true))
    socket.emit('close', 1000, Buffer.from(''))

    await expect(finished).resolves.toBe('first part second part')
  })

  it('resamples 48 kHz chunks seamlessly and never sends an empty audio frame', () => {
    const { session, socket } = start('deepgram-nova-3')
    socket.open()

    session.feedAudio(new Float32Array(1), 48_000)
    expect(socket.sent).toHaveLength(0)
    session.feedAudio(new Float32Array(4095).fill(0.1), 48_000)
    session.feedAudio(new Float32Array(4096).fill(0.1), 48_000)

    const audioBytes = socket.sent.reduce(
      (total, frame) => total + (Buffer.isBuffer(frame) ? frame.length : 0),
      0
    )
    expect(Math.abs(audioBytes / 2 - 2731)).toBeLessThanOrEqual(1)
  })

  it('fails on a typed Error frame mid-stream', () => {
    const { sink, socket } = start('deepgram-nova-3')
    socket.open()

    socket.receive({ type: 'Error', description: 'Bad audio', code: 'DATA-0000' })

    expect(sink).toHaveBeenCalledWith({
      type: 'error',
      error: 'Deepgram error: Bad audio (DATA-0000)'
    })
    expect(socket.closedWith).toBe(1000)
  })

  it('reports a typed Error frame after finish began and keeps committed text', async () => {
    const { session, sink, socket } = start('deepgram-nova-3')
    socket.open()
    session.feedAudio(SPEECH, 16_000)
    socket.receive(results('kept words', true))

    const finished = session.finish()
    socket.receive({ type: 'Error', description: 'Flush failed' })

    await expect(finished).resolves.toBe('kept words')
    expect(sink).toHaveBeenCalledWith({ type: 'error', error: 'Deepgram error: Flush failed' })
  })

  it('maps a rejected handshake to a key error', () => {
    const { sink, socket } = start('deepgram-nova-3')

    socket.emit('unexpected-response', { destroy: vi.fn() }, { statusCode: 401 })

    expect(sink).toHaveBeenCalledWith({
      type: 'error',
      error: 'Deepgram rejected the API key (401).'
    })
    expect(socket.closedWith).toBe('terminated')
  })
})

describe('realtime session lifecycle', () => {
  it('returns the running text when the provider never confirms the flush', async () => {
    vi.useFakeTimers()
    try {
      const { session, socket } = start('deepgram-nova-3')
      socket.open()
      session.feedAudio(SPEECH, 16_000)
      socket.receive(results('partial only', false))

      const finished = session.finish()
      await vi.advanceTimersByTimeAsync(10_000)

      await expect(finished).resolves.toBe('partial only')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails fast when the provider never acknowledges the stream', async () => {
    vi.useFakeTimers()
    try {
      const { session, sink, socket } = start('elevenlabs-scribe-v2-realtime')
      socket.open()
      session.feedAudio(SPEECH, 16_000)

      await vi.advanceTimersByTimeAsync(REALTIME_ACCEPT_TIMEOUT_MS)

      expect(sink).toHaveBeenCalledWith({
        type: 'error',
        error: 'ElevenLabs did not start the stream in time.'
      })
      expect(socket.closedWith).toBe(1000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps an acknowledged stream past the accept deadline', async () => {
    vi.useFakeTimers()
    try {
      const { sink, socket } = start('soniox-stt-rt-v5')
      socket.open()

      await vi.advanceTimersByTimeAsync(REALTIME_ACCEPT_TIMEOUT_MS)

      expect(sink).not.toHaveBeenCalled()
      expect(socket.closedWith).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancel closes the socket without waiting', () => {
    const { session, socket } = start('soniox-stt-rt-v5')
    socket.open()

    session.cancel()

    expect(socket.closedWith).toBe(1000)
  })

  it('reports a provider close before finish even when the code is normal', () => {
    const { session, sink, socket } = start('soniox-stt-rt-v5')
    socket.open()
    session.feedAudio(SPEECH, 16_000)

    socket.emit('close', 1000, Buffer.from('session limit'))

    expect(sink).toHaveBeenCalledWith({
      type: 'error',
      error: 'Soniox closed the stream (1000: session limit).'
    })
  })

  it('cancel during finish settles without waiting for the flush timeout', async () => {
    const { session, socket } = start('soniox-stt-rt-v5')
    socket.open()
    session.feedAudio(SPEECH, 16_000)
    socket.receive({ tokens: [{ text: 'kept', is_final: true }] })

    const finished = session.finish()
    session.cancel()

    await expect(finished).resolves.toBe('kept')
  })

  it('finishes immediately when no audio was streamed', async () => {
    const { session, socket } = start('soniox-stt-rt-v5')

    await expect(session.finish()).resolves.toBe('')
    expect(socket.closedWith).toBe('terminated')
  })
})

describe('realtime session failures', () => {
  function startWith(modelId: string, readApiKey: () => string) {
    const manifest = getCatalogModel(modelId)
    if (!manifest) {
      throw new Error(`missing ${modelId}`)
    }
    return createCloudSpeechSession(manifest, { readApiKey, sink: vi.fn() })
  }

  it('rejects creation when the key cannot be read', () => {
    expect(() =>
      startWith('soniox-stt-rt-v5', () => {
        throw new Error('Soniox API key is not configured')
      })
    ).toThrow('Soniox API key is not configured')
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('rejects creation without echoing the key when the socket cannot be built', () => {
    FakeWebSocket.constructError = new Error('Invalid header value: "sk-live-secret-value"')

    expect(() => startWith('deepgram-nova-3', () => 'sk-live-secret-value')).toThrow(
      'API key contains invalid characters.'
    )
  })

  it('reports a socket error once, sanitized, and closes the socket', () => {
    const { sink, socket } = start('deepgram-nova-3')
    socket.open()

    socket.emit('error', new Error('connect failed for token=abcdef123456'))
    socket.emit('error', new Error('second failure'))

    expect(sink.mock.calls).toEqual([[{ type: 'error', error: 'connect failed for [redacted]' }]])
    expect(socket.closedWith).toBe(1000)
  })

  it('surfaces audio dropped because the provider never accepted before stop', async () => {
    vi.useFakeTimers()
    try {
      const { session, sink, socket } = start('elevenlabs-scribe-v2-realtime')
      socket.open()
      session.feedAudio(SPEECH, 16_000)

      const finished = session.finish()
      await vi.advanceTimersByTimeAsync(REALTIME_FINISH_TIMEOUT_MS)

      await expect(finished).resolves.toBe('')
      expect(sink).toHaveBeenCalledWith({
        type: 'error',
        error: 'ElevenLabs did not start the stream in time.'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails instead of buffering when the socket stops draining', () => {
    const { session, sink, socket } = start('soniox-stt-rt-v5')
    socket.open()
    socket.bufferedAmount = MAX_REALTIME_BUFFERED_BYTES

    session.feedAudio(SPEECH, 16_000)

    expect(sink).toHaveBeenCalledWith({ type: 'error', error: 'Soniox connection is too slow.' })
    expect(socket.sent.filter((frame) => Buffer.isBuffer(frame))).toHaveLength(0)
  })

  it('refuses an unsupported sample rate before resampling', () => {
    const { session } = start('soniox-stt-rt-v5')

    expect(() => session.feedAudio(SPEECH, 1)).toThrow('Unsupported audio sample rate')
    expect(() => session.feedAudio(SPEECH, Number.NaN)).toThrow('Unsupported audio sample rate')
  })
})

function results(transcript: string, isFinal: boolean): Record<string, unknown> {
  return { type: 'Results', is_final: isFinal, channel: { alternatives: [{ transcript }] } }
}
