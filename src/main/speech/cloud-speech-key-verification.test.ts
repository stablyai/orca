import { describe, expect, it, vi } from 'vitest'

const { verifySonioxApiKey, verifyDeepgramApiKey } = vi.hoisted(() => ({
  verifySonioxApiKey: vi.fn(async () => ({ ok: true, message: null })),
  verifyDeepgramApiKey: vi.fn(async () => ({ ok: true, message: null }))
}))

vi.mock('./soniox-key-verification', () => ({ verifySonioxApiKey }))
vi.mock('./deepgram-key-verification', () => ({ verifyDeepgramApiKey }))

import { verifyCloudSpeechApiKey } from './cloud-speech-key-verification'

function respond(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('verifyCloudSpeechApiKey', () => {
  it.each([
    ['groq', 'https://api.groq.com/openai/v1/models', 'Authorization', 'Bearer key-1'],
    ['mistral', 'https://api.mistral.ai/v1/models', 'Authorization', 'Bearer key-1']
  ] as const)('probes %s with a cheap authenticated GET', async (provider, url, header, value) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(respond(200))

    await expect(verifyCloudSpeechApiKey(provider, ' key-1 ', fetchMock)).resolves.toEqual({
      ok: true,
      message: null
    })
    const [calledUrl, init] = fetchMock.mock.calls[0]
    expect(calledUrl).toBe(url)
    expect(new Headers(init?.headers).get(header)).toBe(value)
    expect(init?.method).toBe('GET')
  })

  it('probes OpenAI by transcribing 100 ms of silence', async () => {
    const response = respond(200, { text: '' })
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response)

    await expect(verifyCloudSpeechApiKey('openai', ' sk-key-1 ', fetchMock)).resolves.toEqual({
      ok: true,
      message: null
    })
    const [calledUrl, init] = fetchMock.mock.calls[0]
    expect(calledUrl).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer sk-key-1')
    const form = init?.body
    expect(form).toBeInstanceOf(FormData)
    if (!(form instanceof FormData)) {
      return
    }
    expect(form.get('model')).toBe('gpt-4o-mini-transcribe')
    expect(form.get('response_format')).toBe('json')
    const file = form.get('file')
    expect(file).toBeInstanceOf(Blob)
    // 44-byte WAV header + 1600 PCM16 samples.
    expect(file instanceof Blob && file.size).toBe(44 + 3200)
    expect(response.bodyUsed).toBe(true)
  })

  it.each([
    {
      code: 'audio_too_short',
      param: 'file',
      message: 'Audio file is too short. Minimum audio length is 0.1 seconds.'
    },
    { code: null, param: 'file', message: 'Audio file might be corrupted or unsupported' }
  ])('accepts an OpenAI 400 about the probe audio ($code)', async (error) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(respond(400, { error: { type: 'invalid_request_error', ...error } }))

    await expect(verifyCloudSpeechApiKey('openai', 'sk-key-1', fetchMock)).resolves.toEqual({
      ok: true,
      message: null
    })
  })

  it('reports an OpenAI 400 that is not about the audio as an error', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      respond(400, {
        error: { type: 'invalid_request_error', param: 'model', message: 'Invalid model.' }
      })
    )

    await expect(verifyCloudSpeechApiKey('openai', 'sk-key-1', fetchMock)).resolves.toEqual({
      ok: false,
      message: 'OpenAI returned an error (400). Invalid model.'
    })
  })

  it.each([
    [
      401,
      'You have insufficient permissions for this operation. Missing scopes: api.model.audio.request.',
      'OpenAI rejected this API key (401). You have insufficient permissions'
    ],
    [403, 'Country not supported.', 'OpenAI denied access for this API key (403). Country']
  ])('rejects an OpenAI %i without leaking the key', async (status, message, expected) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(respond(status, { error: { message, code: null } }))

    const result = await verifyCloudSpeechApiKey('openai', 'sk-restricted-key-123', fetchMock)

    expect(result.ok).toBe(false)
    expect(result.message).toContain(expected)
    expect(result.message).not.toContain('sk-restricted-key-123')
  })

  it('verifies Deepgram on its live endpoint instead of an HTTP probe', async () => {
    const fetchMock = vi.fn<typeof fetch>()

    await expect(verifyCloudSpeechApiKey('deepgram', ' key-1 ', fetchMock)).resolves.toEqual({
      ok: true,
      message: null
    })
    expect(verifyDeepgramApiKey).toHaveBeenCalledWith('key-1', 10_000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('probes ElevenLabs by minting a realtime Scribe token without reading it', async () => {
    const response = respond(200, { token: 'sutkn_secret' })
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response)

    await expect(verifyCloudSpeechApiKey('elevenlabs', 'sk_stt_only', fetchMock)).resolves.toEqual({
      ok: true,
      message: null
    })
    const [calledUrl, init] = fetchMock.mock.calls[0]
    expect(calledUrl).toBe('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('xi-api-key')).toBe('sk_stt_only')
    expect(response.bodyUsed).toBe(true)
  })

  it('verifies Soniox on its real-time endpoint instead of an HTTP probe', async () => {
    const fetchMock = vi.fn<typeof fetch>()

    await expect(verifyCloudSpeechApiKey('soniox', ' key-1 ', fetchMock)).resolves.toEqual({
      ok: true,
      message: null
    })
    expect(verifySonioxApiKey).toHaveBeenCalledWith('key-1', 10_000)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the Gemini header instead of a query-string key', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(respond(200))

    await verifyCloudSpeechApiKey('gemini', 'AIzaKey', fetchMock)

    const [calledUrl, init] = fetchMock.mock.calls[0]
    expect(String(calledUrl)).not.toContain('AIzaKey')
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('AIzaKey')
  })

  it('reports a rejected key with the provider reason and no key material', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(respond(401, { message: 'Incorrect API key provided: sk-secret12345' }))

    const result = await verifyCloudSpeechApiKey('groq', 'sk-secret12345', fetchMock)

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Groq rejected this API key (401).')
    expect(result.message).not.toContain('sk-secret12345')
  })

  it('treats an ElevenLabs 400 invalid-key answer as a rejection', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(respond(400, { detail: { message: 'API key is invalid.' } }))

    const result = await verifyCloudSpeechApiKey('elevenlabs', 'bad', fetchMock)

    expect(result).toEqual({
      ok: false,
      message: 'ElevenLabs rejected this API key (400). API key is invalid.'
    })
  })

  it('rejects an ElevenLabs key that lacks the speech_to_text scope', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      respond(401, {
        detail: {
          status: 'missing_permissions',
          message:
            'The API key you used is missing the permission speech_to_text to execute this operation.'
        }
      })
    )

    const result = await verifyCloudSpeechApiKey('elevenlabs', 'sk_tts_only', fetchMock)

    expect(result.ok).toBe(false)
    expect(result.message).toContain('ElevenLabs rejected this API key (401).')
  })

  it('rejects an invalid ElevenLabs key', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        respond(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } })
      )

    await expect(verifyCloudSpeechApiKey('elevenlabs', 'sk_bad', fetchMock)).resolves.toEqual({
      ok: false,
      message: 'ElevenLabs rejected this API key (401). Invalid API key'
    })
  })

  it('reports network failures without throwing', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'))

    const result = await verifyCloudSpeechApiKey('groq', 'gsk_x', fetchMock)

    expect(result).toEqual({ ok: false, message: 'Could not reach Groq: getaddrinfo ENOTFOUND' })
  })

  it('rejects a key with a line break before any network call', async () => {
    const fetchMock = vi.fn<typeof fetch>()

    const result = await verifyCloudSpeechApiKey('soniox', 'abc123\n456def', fetchMock)

    expect(result).toEqual({
      ok: false,
      message: 'API key contains spaces, line breaks, or other invalid characters.'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
