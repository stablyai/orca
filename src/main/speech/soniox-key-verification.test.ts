import { afterEach, describe, expect, it, vi } from 'vitest'

const { FakeWebSocket } = await vi.hoisted(async () => {
  const { FakeProviderWebSocket } = await import('./fake-provider-websocket.test-fixture')
  return { FakeWebSocket: FakeProviderWebSocket }
})

vi.mock('./cloud-speech-websocket', () => ({
  openProviderWebSocket: (url: string | URL, headers?: Record<string, string>) =>
    new FakeWebSocket(url, headers)
}))

import { verifySonioxApiKey } from './soniox-key-verification'

const KEY = 'soniox-secret-key-123'

function probe(timeoutMs = 10_000) {
  const result = verifySonioxApiKey(KEY, timeoutMs)
  return { result, socket: FakeWebSocket.latest() }
}

afterEach(() => {
  FakeWebSocket.reset()
  vi.useRealTimers()
})

describe('verifySonioxApiKey', () => {
  it('streams a short silent session with the key in the handshake header only', async () => {
    const { result, socket } = probe()
    socket.open()

    expect(socket.url).toBe('wss://stt-rt.soniox.com/transcribe-websocket')
    expect(socket.headers).toEqual({ Authorization: `Bearer ${KEY}` })
    const [config, audio, end] = socket.sent
    expect(JSON.parse(String(config))).toEqual({
      model: 'stt-rt-v5',
      audio_format: 'pcm_s16le',
      sample_rate: 16000,
      num_channels: 1
    })
    expect(String(config)).not.toContain(KEY)
    expect(Buffer.isBuffer(audio) && audio.length).toBe(3200)
    expect(end).toBe('')

    socket.receive({ tokens: [], finished: true })
    await expect(result).resolves.toEqual({ ok: true, message: null })
    expect(socket.closedWith).toBe(1000)
  })

  it('rejects an unauthenticated key with the sanitized provider message', async () => {
    const { result, socket } = probe()
    socket.open()
    socket.receive({
      error_code: 401,
      error_type: 'unauthenticated',
      error_message: `Invalid API key: ${KEY}`
    })

    const verdict = await result
    expect(verdict).toEqual({
      ok: false,
      message: 'Soniox rejected this API key (401). Invalid API key: [redacted]'
    })
    expect(socket.closedWith).toBe(1000)
  })

  it('words a permission error apart from an invalid key', async () => {
    const { result, socket } = probe()
    socket.open()
    socket.receive({
      error_code: 403,
      error_type: 'permission_denied',
      error_message: 'Real-time STT not allowed.'
    })

    await expect(result).resolves.toEqual({
      ok: false,
      message: 'Soniox denied access for this API key (403). Real-time STT not allowed.'
    })
  })

  it('reports other provider errors without calling the key rejected', async () => {
    const { result, socket } = probe()
    socket.open()
    socket.receive({ error_code: 503, error_type: 'unavailable', error_message: 'Busy.' })

    await expect(result).resolves.toEqual({
      ok: false,
      message: 'Soniox returned an error (503). Busy.'
    })
  })

  it('treats a 401 handshake response as a rejected key', async () => {
    const { result, socket } = probe()
    const request = { destroy: vi.fn() }
    socket.emit('unexpected-response', request, { statusCode: 401 })

    await expect(result).resolves.toEqual({
      ok: false,
      message: 'Soniox rejected this API key (401).'
    })
    expect(request.destroy).toHaveBeenCalled()
    expect(socket.closedWith).toBe('terminated')
  })

  it('reports a network failure without leaking the key', async () => {
    const { result, socket } = probe()
    socket.emit('error', new Error(`connect ECONNREFUSED for ${KEY}`))

    const verdict = await result
    expect(verdict.ok).toBe(false)
    expect(verdict.message).toContain('Could not reach Soniox: connect ECONNREFUSED')
    expect(verdict.message).not.toContain(KEY)
  })

  it('reports a key the socket refuses to put in a header without echoing it', async () => {
    FakeWebSocket.constructError = new Error(`Invalid header value: "Bearer ${KEY}"`)

    const verdict = await verifySonioxApiKey(KEY, 10_000)

    expect(verdict).toEqual({
      ok: false,
      message: 'Could not reach Soniox: API key contains invalid characters.'
    })
  })

  it('fails a socket that closes before Soniox confirms the key', async () => {
    const { result, socket } = probe()
    socket.open()
    socket.emit('close', 1011, Buffer.from(''))

    await expect(result).resolves.toEqual({
      ok: false,
      message: 'Soniox closed the connection before confirming the key (1011).'
    })
  })

  it('gives up and closes the socket after the timeout', async () => {
    vi.useFakeTimers()
    const { result, socket } = probe(5_000)
    socket.open()

    await vi.advanceTimersByTimeAsync(5_000)

    await expect(result).resolves.toEqual({
      ok: false,
      message: 'Soniox did not respond in time.'
    })
    expect(socket.closedWith).toBe(1000)
    expect(socket.listenerCount('message')).toBe(0)
  })
})
