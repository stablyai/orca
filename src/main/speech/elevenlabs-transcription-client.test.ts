import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ElevenLabsTranscriptionSession,
  sanitizeElevenLabsTranscriptionErrorMessage
} from './elevenlabs-transcription-client'

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('sanitizeElevenLabsTranscriptionErrorMessage', () => {
  it('names an invalid key without echoing it', () => {
    expect(
      sanitizeElevenLabsTranscriptionErrorMessage('Invalid API key sk_5f4d3c2b1a provided')
    ).toBe('Incorrect ElevenLabs API key provided.')
  })

  it('redacts credentials from other provider errors', () => {
    expect(
      sanitizeElevenLabsTranscriptionErrorMessage('Rejected xi-api-key: sk_abc123 for request')
    ).toBe('Rejected xi-api-key [redacted] for request')
  })
})

describe('ElevenLabsTranscriptionSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uploads one multipart WAV and returns the transcript', async () => {
    const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async () =>
      jsonResponse({ text: '  hello world  ' }, 200)
    )
    vi.stubGlobal('fetch', fetchMock)

    const session = new ElevenLabsTranscriptionSession('elevenlabs-scribe-v2', () => 'sk_test_key')
    session.feedAudio(new Float32Array(1600), 16000)

    await expect(session.finish()).resolves.toBe('hello world')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'xi-api-key': 'sk_test_key' })
    expect(init.body).toBeInstanceOf(FormData)
    if (init.body instanceof FormData) {
      expect(init.body.get('model_id')).toBe('scribe_v2')
      expect(init.body.get('file')).toBeInstanceOf(Blob)
    }
  })

  it('reports the provider detail for a rejected request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ detail: { message: 'Invalid API key sk_provider_echo' } }, 401))
    )

    const session = new ElevenLabsTranscriptionSession('elevenlabs-scribe-v2', () => 'sk_configured')
    session.feedAudio(new Float32Array(1600), 16000)

    await expect(session.finish()).rejects.toThrow('Incorrect ElevenLabs API key provided.')
  })

  it('surfaces validation messages from the array-shaped error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ detail: [{ msg: 'file is required' }] }, 422))
    )

    const session = new ElevenLabsTranscriptionSession('elevenlabs-scribe-v2', () => 'sk_configured')
    session.feedAudio(new Float32Array(1600), 16000)

    await expect(session.finish()).rejects.toThrow(
      'ElevenLabs transcription failed: file is required'
    )
  })

  it('keeps the per-dictation audio cap', () => {
    const session = new ElevenLabsTranscriptionSession('elevenlabs-scribe-v2', () => 'sk_configured')

    session.feedAudio(new Float32Array(16_000 * 600), 16_000)

    expect(() => session.feedAudio(new Float32Array(16_000), 16_000)).toThrow(
      'Cloud transcription is limited to 10 minutes per dictation'
    )
  })

  it('rejects an unknown catalog id before calling the provider', async () => {
    const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async () =>
      jsonResponse({ text: '' }, 200)
    )
    vi.stubGlobal('fetch', fetchMock)

    const session = new ElevenLabsTranscriptionSession('openai-gpt-4o-transcribe', () => 'sk_key')
    session.feedAudio(new Float32Array(1600), 16000)

    await expect(session.finish()).rejects.toThrow(
      'Unknown ElevenLabs transcription model: openai-gpt-4o-transcribe'
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
