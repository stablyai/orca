import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OpenAiTranscriptionSession,
  sanitizeOpenAiTranscriptionErrorMessage
} from './openai-transcription-client'
import { readChatGptSubscriptionHeaders } from './chatgpt-subscription-auth'
import { resolveCloudTranscriptionTarget } from './cloud-transcription-target'
import { readOpenAiSpeechApiKey } from './openai-api-key-store'
import { setMainHttpClient } from '../network/http-client'

vi.mock('./chatgpt-subscription-auth', () => ({
  readChatGptSubscriptionHeaders: vi.fn()
}))

vi.mock('./openai-api-key-store', () => ({
  hasOpenAiSpeechApiKey: vi.fn(() => true),
  canReadOpenAiSpeechApiKey: vi.fn(() => true),
  readOpenAiSpeechApiKey: vi.fn(() => 'paid-key-must-not-be-used')
}))

describe('sanitizeOpenAiTranscriptionErrorMessage', () => {
  it('does not expose the invalid OpenAI API key echoed by the provider', () => {
    expect(
      sanitizeOpenAiTranscriptionErrorMessage(
        'Incorrect API key provided: fsdfdsfsdf. You can find your API key at https://platform.openai.com/account/api-keys.'
      )
    ).toBe('Incorrect OpenAI API key provided.')
  })

  it('redacts API keys and bearer tokens from other provider errors', () => {
    expect(
      sanitizeOpenAiTranscriptionErrorMessage(
        'Request failed for sk-testSecret123 with Authorization: Bearer token-value_123'
      )
    ).toBe('Request failed for [redacted] with Authorization: Bearer [redacted]')
  })
})

describe('OpenAiTranscriptionSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    setMainHttpClient(null)
  })

  it('uses the proxy multipart protocol without paid fallback or leaked credentials on HTTP 401', async () => {
    vi.mocked(readChatGptSubscriptionHeaders).mockResolvedValue({
      Authorization: 'Bearer subscription-token',
      'ChatGPT-Account-Id': 'subscription-account'
    })
    const requests: string[] = []
    setMainHttpClient({
      proxySession: () => null,
      fetch: async (url, init) => {
        requests.push(url)
        expect(init?.method).toBe('POST')
        expect(init?.redirect).toBe('error')
        expect(init?.credentials).toBe('omit')
        expect(init?.headers).toEqual({
          Authorization: 'Bearer subscription-token',
          'ChatGPT-Account-Id': 'subscription-account'
        })
        const form = init?.body
        if (!(form instanceof FormData)) {
          throw new Error('Expected multipart body')
        }
        expect(form.has('model')).toBe(false)
        expect(form.has('response_format')).toBe(false)
        expect(form.get('language')).toBe('ko')
        expect(form.get('file')).toBeInstanceOf(File)
        return new Response('private subscription-token subscription-account', { status: 401 })
      }
    })
    vi.stubGlobal('fetch', () => {
      throw new Error('Subscription dictation bypassed the main HTTP client')
    })
    const session = new OpenAiTranscriptionSession(
      () => resolveCloudTranscriptionTarget('chatgpt-subscription-transcribe'),
      'ko',
      null
    )
    session.feedAudio(new Float32Array([0.1]), 16000)
    const result = session.finish()
    await expect(result).rejects.toThrow(/login.*expired/i)
    await expect(result).rejects.not.toThrow('subscription-token')
    await expect(result).rejects.not.toThrow('subscription-account')
    expect(readOpenAiSpeechApiKey).not.toHaveBeenCalled()
    expect(requests).toEqual(['https://chatgpt.com/backend-api/transcribe'])
  })

  it.each([
    { status: 403, error: /rejected.*account or client/i },
    { status: 429, error: /limit.*reached/i }
  ])(
    'distinguishes subscription rejection from quota exhaustion on HTTP $status',
    async ({ status, error }) => {
      vi.mocked(readChatGptSubscriptionHeaders).mockResolvedValue({
        Authorization: 'Bearer subscription-token'
      })
      setMainHttpClient({
        proxySession: () => null,
        fetch: async () => new Response('private subscription-token', { status })
      })
      const session = new OpenAiTranscriptionSession(
        () => resolveCloudTranscriptionTarget('chatgpt-subscription-transcribe'),
        undefined,
        null
      )
      session.feedAudio(new Float32Array([0.1]), 16000)
      const result = session.finish()
      await expect(result).rejects.toThrow(error)
      await expect(result).rejects.not.toThrow('subscription-token')
    }
  )

  it('cancels subscription transcription while credentials are being read', async () => {
    const session = new OpenAiTranscriptionSession(
      () => resolveCloudTranscriptionTarget('chatgpt-subscription-transcribe'),
      undefined,
      null
    )
    vi.mocked(readChatGptSubscriptionHeaders).mockImplementation(async () => {
      session.cancel()
      return { Authorization: 'Bearer subscription-token' }
    })
    const upload = vi.fn()
    vi.stubGlobal('fetch', upload)
    session.feedAudio(new Float32Array([0.1]), 16000)
    await expect(session.finish()).rejects.toMatchObject({ name: 'AbortError' })
    expect(upload).not.toHaveBeenCalled()
    expect(readOpenAiSpeechApiKey).not.toHaveBeenCalled()
  })

  it('does not upload or try paid credentials when subscription authentication is rejected', async () => {
    vi.mocked(readChatGptSubscriptionHeaders).mockRejectedValue(
      new Error('ChatGPT subscription login has expired; sign in again through Accounts settings.')
    )
    const upload = vi.fn()
    vi.stubGlobal('fetch', upload)
    const session = new OpenAiTranscriptionSession(
      () => resolveCloudTranscriptionTarget('chatgpt-subscription-transcribe'),
      undefined,
      null
    )
    session.feedAudio(new Float32Array([0.1]), 16000)
    await expect(session.finish()).rejects.toThrow('login has expired')
    expect(upload).not.toHaveBeenCalled()
    expect(readOpenAiSpeechApiKey).not.toHaveBeenCalled()
  })

  it('keeps subscription credentials out of transport and malformed-response errors', async () => {
    vi.mocked(readChatGptSubscriptionHeaders).mockResolvedValue({
      Authorization: 'Bearer subscription-token'
    })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('failed sending subscription-token'))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { message: 'subscription-token' } }))
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ text: ' subscription dictation ' })))
    )
    const transcribe = () => {
      const session = new OpenAiTranscriptionSession(
        () => resolveCloudTranscriptionTarget('chatgpt-subscription-transcribe'),
        undefined,
        null
      )
      session.feedAudio(new Float32Array([0.1]), 16000)
      return session.finish()
    }
    const transportFailure = transcribe()
    await expect(transportFailure).rejects.toThrow(/request failed/i)
    await expect(transportFailure).rejects.not.toThrow('subscription-token')
    const malformedResponse = transcribe()
    await expect(malformedResponse).rejects.toThrow(/response.*text/i)
    await expect(malformedResponse).rejects.not.toThrow('subscription-token')
    expect(await transcribe()).toBe('subscription dictation')
    expect(readOpenAiSpeechApiKey).not.toHaveBeenCalled()
  })

  it('preserves multipart WAV bytes across owned, resampled and empty audio chunks', async () => {
    const uploads: Buffer[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
      expect(init.method).toBe('POST')
      expect(init.headers).toEqual({ Authorization: 'Bearer test-key' })
      const form = init.body
      if (!(form instanceof FormData)) {
        throw new Error('Expected multipart body')
      }
      expect(form.get('model')).toBe('gpt-transcribe')
      expect(form.getAll('languages[]')).toEqual(['de'])
      expect(form.has('language')).toBe(false)
      const file = form.get('file')
      if (!(file instanceof File)) {
        throw new Error('Expected WAV upload')
      }
      expect(file.name).toBe('dictation.wav')
      expect(file.type).toBe('audio/wav')
      uploads.push(Buffer.from(await file.arrayBuffer()))
      return new Response(JSON.stringify({ text: ' complete dictation ' }))
    })
    const session = new OpenAiTranscriptionSession(
      () => ({
        url: 'https://api.openai.com/v1/audio/transcriptions',
        model: 'gpt-transcribe',
        apiKey: 'test-key',
        label: 'OpenAI'
      }),
      'de',
      null
    )
    const input = new Float32Array([
      -2,
      -1,
      -0.5,
      -1 / 65536,
      0,
      0.5,
      1,
      2,
      Number.NaN,
      Infinity,
      -Infinity
    ])
    session.feedAudio(input, 16000)
    input.fill(0)
    session.feedAudio(new Float32Array(), 16000)
    session.feedAudio(new Float32Array([0, 0.25, 0.5, 0.75, 1, 1.25]), 48000)
    expect(await session.finish()).toBe('complete dictation')
    expect(await session.finish()).toBe('')
    expect(uploads).toHaveLength(1)
    const wav = uploads[0]
    expect(wav.subarray(0, 44).toString('hex')).toBe(
      '524946463e00000057415645666d74201000000001000100803e0000007d000002001000646174611a000000'
    )
    expect(Array.from({ length: 13 }, (_, i) => wav.readInt16LE(44 + i * 2))).toEqual([
      -32768, -32768, -16384, 0, 0, 16384, 32767, 32767, 0, 32767, -32768, 0, 24575
    ])
  })

  it('sends a keyless server the singular language field and no Authorization header', async () => {
    let sent: RequestInit | undefined
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent = init
      return new Response(JSON.stringify({ text: 'hola' }))
    })
    const session = new OpenAiTranscriptionSession(
      () => ({
        url: 'http://127.0.0.1:8000/v1/audio/transcriptions',
        model: 'whisper-large-v3-turbo',
        apiKey: '',
        label: '127.0.0.1:8000'
      }),
      'es',
      null
    )
    session.feedAudio(new Float32Array(160), 16000)

    expect(await session.finish()).toBe('hola')
    const form = sent?.body
    if (!(form instanceof FormData)) {
      throw new Error('Expected multipart body')
    }
    expect(form.get('language')).toBe('es')
    expect(form.has('languages[]')).toBe(false)
    expect(sent?.headers).toEqual({})
  })
})
