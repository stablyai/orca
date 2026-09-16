import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OPENAI_TRANSCRIPTION_MODEL_BY_ID,
  OpenAiTranscriptionSession,
  sanitizeOpenAiTranscriptionErrorMessage
} from './openai-transcription-client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OPENAI_TRANSCRIPTION_MODEL_BY_ID', () => {
  it('maps the GPT Transcribe catalog id to the API model id', () => {
    expect(OPENAI_TRANSCRIPTION_MODEL_BY_ID['openai-gpt-transcribe']).toBe('gpt-transcribe')
  })
})

describe('OpenAiTranscriptionSession', () => {
  it('sends GPT Transcribe audio using the JSON response format', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData
      expect(form.get('model')).toBe('gpt-transcribe')
      expect(form.get('response_format')).toBe('json')
      expect(form.get('file')).toBeInstanceOf(Blob)
      return new Response(JSON.stringify({ text: '  test transcript  ' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const session = new OpenAiTranscriptionSession('openai-gpt-transcribe', () => 'test-key')

    session.feedAudio(new Float32Array(160), 16000)

    await expect(session.finish()).resolves.toBe('test transcript')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/transcriptions',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer test-key' }
      })
    )
  })
})

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
