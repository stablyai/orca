import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { discoverCustomSttModels } from './custom-stt-endpoint-models'

describe('discoverCustomSttModels', () => {
  const fetchMock = vi.fn()

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

  it('reads the OpenAI /v1/models shape first', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 'large-v3' }, { id: 'small' }] }), {
        status: 200
      })
    )

    const result = await discoverCustomSttModels({ baseUrl: 'http://h:1/v1' })

    expect(result.ok).toBe(true)
    expect(result.models).toEqual(['large-v3', 'small'])
    expect(result.source).toBe('openai-models')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://h:1/v1/models')
  })

  it('falls back to a health document with supportedModels', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ supportedModels: ['large-v3', 'base'] }), { status: 200 })
      )

    const result = await discoverCustomSttModels({ baseUrl: 'http://h:8090/v1' })

    expect(result.ok).toBe(true)
    expect(result.models).toEqual(['large-v3', 'base'])
    expect(result.source).toBe('health')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://h:8090/health')
  })

  it('derives the root even when the base names the transcription path', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 'whisper-1' }] }), { status: 200 })
    )

    await discoverCustomSttModels({ baseUrl: 'http://h:1/v1/audio/transcriptions' })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://h:1/v1/models')
  })

  it('attaches the bearer token when provided', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 'x' }] }), { status: 200 })
    )

    await discoverCustomSttModels({ baseUrl: 'http://h:1/v1', apiKey: 'secret' })

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret')
  })

  it('reports reachable-but-empty when the server answers without a list', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }))

    const result = await discoverCustomSttModels({ baseUrl: 'http://h:1/v1' })

    expect(result.ok).toBe(false)
    expect(result.models).toEqual([])
    expect(result.reachability).toBe('reachable')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('treats a 401 as reachable (server exists, needs a token)', async () => {
    fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }))

    const result = await discoverCustomSttModels({ baseUrl: 'https://api.groq.com/openai/v1' })

    expect(result.reachability).toBe('reachable')
    expect(result.models).toEqual([])
  })

  it('reports unreachable when every candidate fails at the transport level', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))

    const result = await discoverCustomSttModels({ baseUrl: 'http://127.0.0.1:9999/v1' })

    expect(result.ok).toBe(false)
    expect(result.reachability).toBe('unreachable')
  })
})
