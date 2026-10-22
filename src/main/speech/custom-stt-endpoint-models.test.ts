import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveUrlMock } = vi.hoisted(() => ({
  resolveUrlMock: (baseUrl: string) => `${baseUrl}/audio/transcriptions`
}))

vi.mock('./custom-stt-endpoint-store', () => ({
  resolveCustomSttTranscriptionUrl: resolveUrlMock
}))

import { discoverCustomSttModels } from './custom-stt-endpoint-models'

const fetchMock = vi.fn()

/** The probe is a POST; model discovery is a GET. Route mocks by method. */
function mockByMethod(handler: (url: string, method: string) => Response): void {
  fetchMock.mockImplementation((url: string, init?: RequestInit) =>
    Promise.resolve(handler(url, init?.method ?? 'GET'))
  )
}

describe('discoverCustomSttModels', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns nothing without a base URL', async () => {
    const result = await discoverCustomSttModels({ baseUrl: '' })
    expect(result.ok).toBe(false)
    expect(result.reachability).toBe('unknown')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is reachable when the transcription route answers (non-404)', async () => {
    mockByMethod((_url, method) =>
      method === 'POST'
        ? new Response('missing file', { status: 422 })
        : new Response(JSON.stringify({ data: [{ id: 'large-v3' }] }), { status: 200 })
    )

    const result = await discoverCustomSttModels({ baseUrl: 'http://h:8090/v1' })

    expect(result.reachability).toBe('reachable')
    expect(result.models).toEqual(['large-v3'])
    expect(result.ok).toBe(true)
  })

  it('is unreachable when the transcription route 404s (e.g. a missing /v1)', async () => {
    // The regression: /health answers 200 but the real path is a 404.
    mockByMethod((_url, method) => {
      if (method === 'POST') {
        return new Response('not found', { status: 404 })
      }
      return new Response('not found', { status: 404 })
    })

    const result = await discoverCustomSttModels({ baseUrl: 'http://h:8090' })

    expect(result.reachability).toBe('unreachable')
    expect(result.ok).toBe(false)
  })

  it('treats a 401 from the route as reachable (URL right, token missing)', async () => {
    mockByMethod((_url, method) =>
      method === 'POST'
        ? new Response('unauthorized', { status: 401 })
        : new Response('{}', { status: 404 })
    )

    const result = await discoverCustomSttModels({ baseUrl: 'https://api.groq.com/openai/v1' })

    expect(result.reachability).toBe('reachable')
  })

  it('is unreachable on a transport failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))

    const result = await discoverCustomSttModels({ baseUrl: 'http://127.0.0.1:9999/v1' })

    expect(result.reachability).toBe('unreachable')
  })

  it('reads the OpenAI /v1/models shape during discovery', async () => {
    mockByMethod((_url, method) => {
      if (method === 'POST') {
        return new Response('', { status: 200 })
      }
      return new Response(JSON.stringify({ data: [{ id: 'large-v3' }, { id: 'small' }] }), {
        status: 200
      })
    })

    const result = await discoverCustomSttModels({ baseUrl: 'http://h:1/v1' })

    expect(result.models).toEqual(['large-v3', 'small'])
    expect(result.source).toBe('openai-models')
  })

  it('falls back to a health document with supportedModels', async () => {
    mockByMethod((url, method) => {
      if (method === 'POST') {
        return new Response('', { status: 200 })
      }
      if (url.endsWith('/v1/models')) {
        return new Response('nope', { status: 404 })
      }
      return new Response(JSON.stringify({ supportedModels: ['large-v3', 'base'] }), {
        status: 200
      })
    })

    const result = await discoverCustomSttModels({ baseUrl: 'http://h:8090/v1' })

    expect(result.models).toEqual(['large-v3', 'base'])
    expect(result.source).toBe('health')
  })

  it('attaches the bearer token to the probe and discovery requests', async () => {
    mockByMethod(() => new Response(JSON.stringify({ data: [{ id: 'x' }] }), { status: 200 }))

    await discoverCustomSttModels({ baseUrl: 'http://h:1/v1', apiKey: 'secret' })

    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret')
    }
  })
})
