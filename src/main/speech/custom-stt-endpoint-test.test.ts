import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { storeState } = vi.hoisted(() => ({
  storeState: { config: null as { baseUrl: string; model: string; language: string } | null }
}))

vi.mock('./custom-stt-endpoint-store', () => ({
  readCustomSttEndpointConfig: () => storeState.config,
  readCustomSttEndpointApiKey: () => null,
  resolveCustomSttTranscriptionUrl: (baseUrl: string) =>
    `${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`
}))

import { testCustomSttEndpoint } from './custom-stt-endpoint-test'

describe('testCustomSttEndpoint', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    storeState.config = null
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects a missing base URL before any fetch', async () => {
    const result = await testCustomSttEndpoint({ baseUrl: '', model: 'large-v3', language: '' })
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/base URL/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a non-http(s) scheme before any fetch', async () => {
    const result = await testCustomSttEndpoint({
      baseUrl: 'ftp://host/v1',
      model: 'large-v3',
      language: ''
    })
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/http/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('tests the inline draft, not the saved config', async () => {
    storeState.config = { baseUrl: 'http://saved:1/v1', model: 'old', language: '' }
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))

    const result = await testCustomSttEndpoint({
      baseUrl: 'http://draft:2/v1',
      model: 'large-v3',
      language: 'en'
    })

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://draft:2/v1/audio/transcriptions')
  })

  it('falls back to the saved config when no draft is given', async () => {
    storeState.config = { baseUrl: 'http://saved:1/v1', model: 'large-v3', language: '' }
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))

    const result = await testCustomSttEndpoint()

    expect(result.ok).toBe(true)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://saved:1/v1/audio/transcriptions')
  })

  it('retries once after a transport failure and reports the cause', async () => {
    storeState.config = { baseUrl: 'http://h:1/v1', model: 'large-v3', language: '' }
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:1')
    })
    fetchMock.mockRejectedValue(refused)

    const result = await testCustomSttEndpoint()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('ECONNREFUSED')
  })

  it('succeeds on the retry after a transient failure', async () => {
    storeState.config = { baseUrl: 'http://h:1/v1', model: 'large-v3', language: '' }
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))

    const result = await testCustomSttEndpoint()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
  })

  it('reports 401 as an authentication failure', async () => {
    storeState.config = { baseUrl: 'http://h:1/v1', model: 'large-v3', language: '' }
    fetchMock.mockResolvedValue(new Response('nope', { status: 401 }))

    const result = await testCustomSttEndpoint()

    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/Authentication/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
