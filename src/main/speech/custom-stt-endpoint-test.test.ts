import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { storeState } = vi.hoisted(() => ({
  storeState: {
    config: null as { baseUrl: string; model: string; language: string } | null,
    savedToken: null as string | null
  }
}))

vi.mock('./custom-stt-endpoint-store', () => ({
  readCustomSttEndpointConfig: () => storeState.config,
  // Mirrors the real resolver: a draft key wins, else the saved token.
  resolveCustomSttApiKeyFor: (_baseUrl: string, draftKey?: string | null) =>
    draftKey?.trim() ? draftKey.trim() : storeState.savedToken,
  resolveCustomSttTranscriptionUrl: (baseUrl: string) =>
    `${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`
}))

import { testCustomSttEndpoint } from './custom-stt-endpoint-test'

describe('testCustomSttEndpoint', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    storeState.config = null
    storeState.savedToken = null
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects a missing base URL before any fetch', async () => {
    const result = await testCustomSttEndpoint({ baseUrl: '', model: 'large-v3', language: '' })
    expect(result.ok).toBe(false)
    expect(result.outcome).toBe('invalid')
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

  it('uses a just-typed API key instead of the saved one', async () => {
    storeState.config = { baseUrl: 'http://h:1/v1', model: 'large-v3', language: '' }
    storeState.savedToken = 'old-saved-token'
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))

    await testCustomSttEndpoint({
      baseUrl: 'http://h:1/v1',
      model: 'large-v3',
      language: '',
      apiKey: 'fresh-draft-key'
    })

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fresh-draft-key')
  })

  it('falls back to the saved config when no draft is given', async () => {
    storeState.config = { baseUrl: 'http://saved:1/v1', model: 'large-v3', language: '' }
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))

    const result = await testCustomSttEndpoint()

    expect(result.ok).toBe(true)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://saved:1/v1/audio/transcriptions')
  })

  it('probes with just a base URL (no model field) to verify reachability', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))

    const result = await testCustomSttEndpoint({
      baseUrl: 'http://h:1/v1',
      model: '',
      language: ''
    })

    expect(result.ok).toBe(true)
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    const form = init?.body as FormData
    expect(form.get('model')).toBeNull()
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
    expect(result.outcome).toBe('auth')
    expect(result.detail).toMatch(/Authentication/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('classifies a 4xx as rejected (e.g. an unsupported language code)', async () => {
    storeState.config = { baseUrl: 'http://h:1/v1', model: 'large-v3', language: 'xx' }
    fetchMock.mockResolvedValue(new Response('not a valid language code', { status: 400 }))

    const result = await testCustomSttEndpoint()

    expect(result.ok).toBe(false)
    expect(result.outcome).toBe('rejected')
  })

  it('classifies an explained 5xx as rejected (servers vary on bad-parameter status)', async () => {
    storeState.config = { baseUrl: 'http://h:1/v1', model: 'large-v3', language: 'english' }
    fetchMock.mockResolvedValue(new Response('not a valid language code', { status: 500 }))

    const result = await testCustomSttEndpoint()

    expect(result.ok).toBe(false)
    expect(result.outcome).toBe('rejected')
  })

  it('treats a bodiless 5xx as transport (likely transient)', async () => {
    storeState.config = { baseUrl: 'http://h:1/v1', model: 'large-v3', language: '' }
    fetchMock.mockResolvedValue(new Response('', { status: 502 }))

    const result = await testCustomSttEndpoint()

    expect(result.ok).toBe(false)
    expect(result.outcome).toBe('transport')
  })
})
