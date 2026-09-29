import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenRouterTranscriptionSession } from './openrouter-transcription-client'

const modelId = 'openrouter-mai-transcribe-2'
const apiKey = 'sk-or-v1-private-key'

function session(): OpenRouterTranscriptionSession {
  const session = new OpenRouterTranscriptionSession(modelId, () => apiKey)
  session.feedAudio(new Float32Array([0, 1, -1]), 16000)
  return session
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('OpenRouterTranscriptionSession', () => {
  it('sends MAI a base64 PCM16 WAV with Bearer authentication and returns trimmed text', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ text: '  Hello world \n' }))
    vi.stubGlobal('fetch', fetchMock)
    const recording = new OpenRouterTranscriptionSession(modelId, () => apiKey)
    const samples = new Float32Array([0.5, 0.5, 0.5, -0.5, -0.5, -0.5])
    recording.feedAudio(samples, 48000)
    samples.fill(0)
    recording.feedAudio(new Float32Array([2, -2]), 16000)
    expect(await recording.finish()).toBe('Hello world')
    expect(await recording.finish()).toBe('')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/audio/transcriptions')
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://onorca.dev',
        'X-OpenRouter-Title': 'Orca'
      }
    })
    if (typeof init?.body !== 'string') {
      throw new Error('Expected JSON body')
    }
    const body = JSON.parse(init.body)
    expect(body.model).toBe('microsoft/mai-transcribe-2')
    expect(body.input_audio.format).toBe('wav')
    const wav = Buffer.from(body.input_audio.data, 'base64')
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt16LE(20)).toBe(1)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.readUInt32LE(40)).toBe(8)
    expect([44, 46, 48, 50].map((offset) => wav.readInt16LE(offset))).toEqual([
      16384, -16384, 32767, -32768
    ])
  })

  it('limits cumulative recording duration to ten minutes', () => {
    const recording = new OpenRouterTranscriptionSession(modelId, () => apiKey)
    recording.feedAudio(new Float32Array(16000 * 600), 16000)
    expect(() => recording.feedAudio(new Float32Array(1), 16000)).toThrow('limited to 10 minutes')
  })

  it('allows more upload time for long recordings while keeping requests bounded', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ text: 'done' }))
    vi.stubGlobal('fetch', fetchMock)
    await session().finish()
    fetchMock.mockResolvedValue(Response.json({ text: 'done' }))
    const recording = new OpenRouterTranscriptionSession(modelId, () => apiKey)
    recording.feedAudio(new Float32Array(16000 * 600), 16000)
    await recording.finish()

    const shortTimeout = timeout.mock.calls[0][0]
    const longTimeout = timeout.mock.calls[1][0]
    expect(shortTimeout).toBeGreaterThanOrEqual(60_000)
    expect(shortTimeout).toBeLessThanOrEqual(90_000)
    expect(longTimeout).toBeGreaterThan(shortTimeout * 2)
    expect(longTimeout).toBeLessThanOrEqual(360_000)
    expect(fetchMock.mock.calls[1][1]?.signal).toBe(timeout.mock.results[1].value)
  })

  it.each([null, undefined])('accepts a transcript with error: %s', async (error) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ text: '  transcript ', error }))
    )
    expect(await session().finish()).toBe('transcript')
  })

  it('does not read credentials or fetch for an empty session', async () => {
    const readKey = vi.fn()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await new OpenRouterTranscriptionSession(modelId, readKey).finish()).toBe('')
    expect(readKey).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [401, { error: { message: `Invalid ${apiKey}` } }, 'Invalid [redacted]'],
    [200, { error: { message: 'Quota exceeded' }, text: 'ignore' }, 'Quota exceeded'],
    [200, { error: 'Provider unavailable' }, 'Provider unavailable'],
    [200, { error: {} }, 'OpenRouter returned a transcription error'],
    [403, {}, 'Check your OpenRouter API key'],
    [401, { error: null, text: 'ignore' }, 'Check your OpenRouter API key'],
    [429, {}, 'HTTP 429'],
    [200, {}, 'did not include text'],
    [200, null, 'did not include text'],
    [200, { text: 42 }, 'did not include text']
  ])('handles response status %s and body %j', async (status, body, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body, { status })))
    await expect(session().finish()).rejects.toThrow(message)
  })

  it('handles malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('invalid json')))
    await expect(session().finish()).rejects.toThrow('did not include text')
  })

  it('redacts actual keys, token patterns, and authorization from network errors', async () => {
    const secret = 'nonstandard-secret'
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValue(
          new Error(`Failed ${secret} sk-or-v1-other-key Authorization: Bearer another-token`)
        )
    )
    const recording = new OpenRouterTranscriptionSession(modelId, () => secret)
    recording.feedAudio(new Float32Array([0]), 16000)
    await expect(recording.finish()).rejects.toThrow(
      'Failed [redacted] [redacted] Authorization: Bearer [redacted]'
    )
  })

  it('rejects unknown model ids before sending audio', async () => {
    const recording = new OpenRouterTranscriptionSession('unknown', () => apiKey)
    recording.feedAudio(new Float32Array([0]), 16000)
    await expect(recording.finish()).rejects.toThrow('Unknown OpenRouter transcription model')
  })
})
