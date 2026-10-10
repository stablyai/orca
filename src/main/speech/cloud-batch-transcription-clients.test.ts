import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCatalogModel } from './model-catalog'
import { createCloudSpeechSession } from './cloud-speech-session-factory'

type CapturedRequest = { url: string; init: RequestInit }

function stubFetch(body: unknown, status = 200): CapturedRequest[] {
  const requests: CapturedRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init })
      return new Response(JSON.stringify(body), { status })
    })
  )
  return requests
}

async function transcribe(modelId: string, language?: string): Promise<string> {
  const manifest = getCatalogModel(modelId)
  if (!manifest) {
    throw new Error(`missing ${modelId}`)
  }
  const session = createCloudSpeechSession(manifest, {
    readApiKey: () => 'test-key',
    language,
    sink: vi.fn()
  })
  session.feedAudio(new Float32Array(4800).fill(0.1), 48_000)
  return session.finish()
}

function formOf(request: CapturedRequest): FormData {
  if (!(request.init.body instanceof FormData)) {
    throw new Error('expected multipart body')
  }
  return request.init.body
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('batch cloud transcription clients', () => {
  it('sends OpenAI the mapped model, language and a 16 kHz WAV', async () => {
    const requests = stubFetch({ text: ' hello ' })

    await expect(transcribe('openai-gpt-4o-transcribe', 'uk')).resolves.toBe('hello')

    expect(requests[0].url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(new Headers(requests[0].init.headers).get('Authorization')).toBe('Bearer test-key')
    const form = formOf(requests[0])
    expect(form.get('model')).toBe('gpt-4o-transcribe')
    expect(form.get('language')).toBe('uk')
    const file = form.get('file')
    expect(file).toBeInstanceOf(Blob)
    // 4800 samples at 48 kHz resample to 1600 at 16 kHz: 44-byte header + 3200 bytes.
    expect(file instanceof Blob ? file.size : 0).toBe(44 + 3200)
  })

  it('routes Groq through the OpenAI-compatible base URL', async () => {
    const requests = stubFetch({ text: 'groq text' })

    await expect(transcribe('groq-whisper-large-v3-turbo')).resolves.toBe('groq text')

    expect(requests[0].url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
    expect(formOf(requests[0]).get('model')).toBe('whisper-large-v3-turbo')
    expect(formOf(requests[0]).get('language')).toBeNull()
  })

  it('sends ElevenLabs Scribe the xi-api-key header and language_code', async () => {
    const requests = stubFetch({ text: 'scribe text' })

    await expect(transcribe('elevenlabs-scribe-v2', 'de')).resolves.toBe('scribe text')

    expect(requests[0].url).toBe('https://api.elevenlabs.io/v1/speech-to-text')
    expect(new Headers(requests[0].init.headers).get('xi-api-key')).toBe('test-key')
    expect(formOf(requests[0]).get('model_id')).toBe('scribe_v2')
    expect(formOf(requests[0]).get('language_code')).toBe('de')
  })

  it('sends Gemini the WAV inline with a language-aware prompt', async () => {
    const requests = stubFetch({
      candidates: [{ content: { parts: [{ text: 'gemini text\n' }] } }]
    })

    await expect(transcribe('gemini-2.5-flash', 'uk')).resolves.toBe('gemini text')

    expect(requests[0].url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
    )
    expect(new Headers(requests[0].init.headers).get('x-goog-api-key')).toBe('test-key')
    const body = JSON.parse(String(requests[0].init.body))
    expect(body.contents[0].parts[0].text).toContain('Ukrainian')
    expect(body.contents[0].parts[1].inlineData.mimeType).toBe('audio/wav')
  })

  it('reads Gemini Transcribe output from audioTranscription parts', async () => {
    stubFetch({
      candidates: [{ content: { parts: [{ audioTranscription: { text: 'Привіт, Орка' } }] } }]
    })

    await expect(transcribe('gemini-3.5-transcribe', 'uk')).resolves.toBe('Привіт, Орка')
  })

  it('sends gpt-transcribe its language as languages[]', async () => {
    const requests = stubFetch({ text: 'gpt text' })

    await expect(transcribe('openai-gpt-transcribe', 'uk')).resolves.toBe('gpt text')

    const form = formOf(requests[0])
    expect(form.get('model')).toBe('gpt-transcribe')
    expect(form.getAll('languages[]')).toEqual(['uk'])
    expect(form.get('language')).toBeNull()
  })

  it('sends Mistral Voxtral the latest mini model', async () => {
    const requests = stubFetch({ text: 'voxtral text' })

    await expect(transcribe('mistral-voxtral-mini')).resolves.toBe('voxtral text')

    expect(requests[0].url).toBe('https://api.mistral.ai/v1/audio/transcriptions')
    expect(new Headers(requests[0].init.headers).get('x-api-key')).toBe('test-key')
    expect(formOf(requests[0]).get('model')).toBe('voxtral-mini-latest')
  })

  it('surfaces a sanitized provider error', async () => {
    stubFetch({ error: { message: 'Invalid API Key gsk_secret123456' } }, 401)

    await expect(transcribe('groq-whisper-large-v3')).rejects.toThrow(
      'Groq transcription failed: Invalid API Key [redacted]'
    )
  })

  it.each([
    ['openai-gpt-4o-transcribe', { text: 42 }, 'OpenAI'],
    ['groq-whisper-large-v3', {}, 'Groq'],
    ['elevenlabs-scribe-v2', { text: null }, 'ElevenLabs'],
    ['mistral-voxtral-mini', ['text'], 'Mistral'],
    ['gemini-2.5-flash', { candidates: [{ content: { parts: 'hello' } }] }, 'Gemini']
  ])('rejects a malformed %s success body', async (modelId, body, label) => {
    stubFetch(body)

    await expect(transcribe(modelId)).rejects.toThrow(
      `${label} returned an invalid transcription response`
    )
  })

  it('keeps a Gemini STOP reply without parts as silence', async () => {
    stubFetch({ candidates: [{ content: { role: 'model' }, finishReason: 'STOP' }] })

    await expect(transcribe('gemini-2.5-flash')).resolves.toBe('')
  })

  it('names the provider when the upload times out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      })
    )

    await expect(transcribe('mistral-voxtral-mini')).rejects.toThrow(
      'Mistral did not respond in time.'
    )
  })

  it('skips the request when no audio was captured', async () => {
    const requests = stubFetch({ text: 'never' })
    const manifest = getCatalogModel('mistral-voxtral-mini')
    if (!manifest) {
      throw new Error('missing model')
    }
    const readApiKey = vi.fn(() => 'test-key')
    const session = createCloudSpeechSession(manifest, { readApiKey, sink: vi.fn() })

    await expect(session.finish()).resolves.toBe('')
    expect(requests).toHaveLength(0)
    expect(readApiKey).not.toHaveBeenCalled()
  })
})
