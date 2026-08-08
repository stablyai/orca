import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeTranscriptionLanguage,
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

describe('normalizeTranscriptionLanguage', () => {
  it('normalizes case and whitespace', () => {
    expect(normalizeTranscriptionLanguage(' PL ')).toBe('pl')
    expect(normalizeTranscriptionLanguage('zh-Hans')).toBe('zh-hans')
  })

  it('rejects empty and malformed values', () => {
    expect(normalizeTranscriptionLanguage(undefined)).toBeUndefined()
    expect(normalizeTranscriptionLanguage('')).toBeUndefined()
    expect(normalizeTranscriptionLanguage('   ')).toBeUndefined()
    expect(normalizeTranscriptionLanguage('polish!')).toBeUndefined()
    expect(normalizeTranscriptionLanguage('not a language')).toBeUndefined()
  })
})

describe('OpenAiTranscriptionSession language hint', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function finishSessionForm(readLanguage?: () => string | undefined): Promise<FormData> {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ text: 'ok' }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const session = new OpenAiTranscriptionSession(
      'openai-gpt-4o-mini-transcribe',
      () => 'sk-test',
      readLanguage
    )
    session.feedAudio(new Float32Array(1600), 16000)
    await session.finish()
    const request = fetchMock.mock.calls[0]?.[1]
    expect(request?.body).toBeInstanceOf(FormData)
    return request?.body as FormData
  }

  it('sends the configured transcription language', async () => {
    const form = await finishSessionForm(() => 'pl')
    expect(form.get('language')).toBe('pl')
  })

  it('omits the language field for auto-detect', async () => {
    const form = await finishSessionForm(undefined)
    expect(form.has('language')).toBe(false)
  })

  it('omits the language field for invalid stored values', async () => {
    const form = await finishSessionForm(() => 'not a language')
    expect(form.has('language')).toBe(false)
  })
})
