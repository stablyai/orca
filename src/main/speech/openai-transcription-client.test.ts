import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OpenAiTranscriptionSession,
  sanitizeOpenAiTranscriptionErrorMessage
} from './openai-transcription-client'

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
  afterEach(() => vi.unstubAllGlobals())

  it('sends the dictation language only when one is chosen', async () => {
    const languages: (FormDataEntryValue | null)[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      languages.push(init.body instanceof FormData ? init.body.get('language') : 'not multipart')
      return new Response(JSON.stringify({ text: 'ok' }))
    })
    for (const language of ['ko', undefined]) {
      const session = new OpenAiTranscriptionSession(
        'openai-gpt-4o-mini-transcribe',
        () => 'test-key',
        language
      )
      session.feedAudio(new Float32Array([0.1]), 16000)
      await session.finish()
    }
    expect(languages).toEqual(['ko', null])
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
      expect(form.get('model')).toBe('gpt-4o-mini-transcribe')
      expect(form.get('response_format')).toBe('json')
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
      'openai-gpt-4o-mini-transcribe',
      () => 'test-key'
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

  it('keeps the first 10 minutes and reports the cap once instead of throwing', async () => {
    const uploadBytes: number[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const file = init.body instanceof FormData ? init.body.get('file') : null
      uploadBytes.push(file instanceof File ? file.size : -1)
      return new Response(JSON.stringify({ text: 'first ten minutes' }))
    })
    const session = new OpenAiTranscriptionSession(
      'openai-gpt-4o-mini-transcribe',
      () => 'test-key'
    )
    const sevenSeconds = new Float32Array(7 * 16000).fill(0.1)
    const capReports = Array.from({ length: 90 }, () => session.feedAudio(sevenSeconds, 16000))
    expect(capReports.indexOf(true)).toBe(85)
    expect(capReports.filter(Boolean)).toHaveLength(1)
    expect(await session.finish()).toBe('first ten minutes')
    expect(uploadBytes).toEqual([44 + 600 * 16000 * 2])
  })
})
