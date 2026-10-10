import { afterEach, describe, expect, it, vi } from 'vitest'

const { FakeWebSocket } = await vi.hoisted(async () => {
  const { FakeProviderWebSocket } = await import('./fake-provider-websocket.test-fixture')
  return { FakeWebSocket: FakeProviderWebSocket }
})

vi.mock('./cloud-speech-websocket', () => ({
  openProviderWebSocket: (url: string | URL, headers?: Record<string, string>) =>
    new FakeWebSocket(url, headers)
}))

import { verifyDeepgramApiKey } from './deepgram-key-verification'

const KEY = 'deepgram-secret-key-123'

function probe(timeoutMs = 10_000) {
  const result = verifyDeepgramApiKey(KEY, timeoutMs)
  return { result, socket: FakeWebSocket.latest() }
}

afterEach(() => {
  FakeWebSocket.reset()
  vi.useRealTimers()
})

describe('verifyDeepgramApiKey', () => {
  it('streams 100 ms of silence to the live endpoint with the key in the header only', async () => {
    const { result, socket } = probe()
    socket.open()

    expect(String(socket.url)).toBe(
      'wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1'
    )
    expect(socket.headers).toEqual({ Authorization: `Token ${KEY}` })
    const [audio, end] = socket.sent
    expect(Buffer.isBuffer(audio) && audio.length).toBe(3200)
    expect(JSON.parse(String(end))).toEqual({ type: 'CloseStream' })

    socket.receive({ type: 'Results', is_final: true, channel: { alternatives: [] } })
    await expect(result).resolves.toEqual({ ok: true, message: null })
    expect(socket.closedWith).toBe(1000)
  })

  it('accepts the Metadata frame Deepgram sends when it flushes', async () => {
    const { result, socket } = probe()
    socket.open()
    socket.receive({ type: 'Metadata', request_id: 'r1' })

    await expect(result).resolves.toEqual({ ok: true, message: null })
  })

  it('accepts a clean close after the probe audio was sent', async () => {
    const { result, socket } = probe()
    socket.open()
    socket.emit('close', 1000, Buffer.from(''))

    await expect(result).resolves.toEqual({ ok: true, message: null })
  })

  it.each([
    [401, 'Deepgram rejected this API key (401).'],
    [403, 'Deepgram denied access for this API key (403).'],
    [500, 'Deepgram refused the streaming connection (500).']
  ])('maps a %i handshake response', async (status, message) => {
    const { result, socket } = probe()
    const request = { destroy: vi.fn() }
    socket.emit('unexpected-response', request, { statusCode: status })

    await expect(result).resolves.toEqual({ ok: false, message })
    expect(request.destroy).toHaveBeenCalled()
    expect(socket.closedWith).toBe('terminated')
  })

  it('reports an Error frame with the sanitized provider message', async () => {
    const { result, socket } = probe()
    socket.open()
    socket.receive({ type: 'Error', description: `Bad request for ${KEY}`, variant: 'DATA-0000' })

    await expect(result).resolves.toEqual({
      ok: false,
      message: 'Deepgram returned an error. Bad request for [redacted]'
    })
    expect(socket.closedWith).toBe(1000)
  })

  it('fails a socket that closes abnormally before confirming the key', async () => {
    const { result, socket } = probe()
    socket.open()
    socket.emit('close', 1011, Buffer.from(''))

    await expect(result).resolves.toEqual({
      ok: false,
      message: 'Deepgram closed the connection before confirming the key (1011).'
    })
  })

  it('reports a network failure without leaking the key', async () => {
    const { result, socket } = probe()
    socket.emit('error', new Error(`connect ECONNREFUSED for ${KEY}`))

    const verdict = await result
    expect(verdict.ok).toBe(false)
    expect(verdict.message).toContain('Could not reach Deepgram: connect ECONNREFUSED')
    expect(verdict.message).not.toContain(KEY)
  })

  it('gives up and closes the socket after the timeout', async () => {
    vi.useFakeTimers()
    const { result, socket } = probe(5_000)
    socket.open()

    await vi.advanceTimersByTimeAsync(5_000)

    await expect(result).resolves.toEqual({
      ok: false,
      message: 'Deepgram did not respond in time.'
    })
    expect(socket.closedWith).toBe(1000)
    expect(socket.listenerCount('message')).toBe(0)
  })
})
