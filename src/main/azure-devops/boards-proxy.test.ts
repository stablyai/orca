import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeBoardsProxyRequest } from './boards-proxy'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function contentTypeOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('content-type')
}

describe('executeBoardsProxyRequest', () => {
  it('reports not_configured when no base url is set', async () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', '')

    const result = await executeBoardsProxyRequest({ method: 'GET', path: '/_apis/projects' })

    expect(result).toMatchObject({ status: 412, code: 'not_configured' })
  })

  it('reports not_configured when a base url is set but no credentials are configured', async () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', 'https://dev.azure.com/org')
    vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', '')
    vi.stubEnv('ORCA_AZURE_DEVOPS_PAT', '')
    vi.stubEnv('ORCA_AZURE_DEVOPS_ACCESS_TOKEN', '')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await executeBoardsProxyRequest({ method: 'GET', path: '/_apis/projects' })

    expect(result).toMatchObject({ status: 412, code: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports not_configured, not 503, when the base url has no scheme', async () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', 'dev.azure.com/org')
    vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', 'super-secret-pat')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await executeBoardsProxyRequest({ method: 'GET', path: '/_apis/projects' })

    expect(result).toMatchObject({ status: 412, code: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports not_configured, not 503, for an on-prem base with the scheme omitted', async () => {
    // 'ado.example.com:8443/...' parses as protocol 'ado.example.com:', which
    // `new URL()` accepts without throwing.
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', 'ado.example.com:8443/tfs/MyCollection')
    vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', 'super-secret-pat')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await executeBoardsProxyRequest({ method: 'GET', path: '/_apis/projects' })

    expect(result).toMatchObject({ status: 412, code: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports not_configured for a data: base URL', async () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', 'data:text/plain,hello')
    vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', 'super-secret-pat')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await executeBoardsProxyRequest({ method: 'GET', path: '/_apis/projects' })

    expect(result).toMatchObject({ status: 412, code: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not echo the base URL in the not_configured message', async () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', 'ado.example.com:8443/tfs/MyCollection')
    vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', 'super-secret-pat')
    vi.stubGlobal('fetch', vi.fn())

    const result = await executeBoardsProxyRequest({ method: 'GET', path: '/_apis/projects' })

    expect(JSON.stringify(result)).not.toContain('ado.example.com')
  })

  it('refuses a path outside the Boards scope before any fetch', async () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', 'https://dev.azure.com/org')
    vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', 'super-secret-pat')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ count: 0 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await executeBoardsProxyRequest({
      method: 'GET',
      path: '/_apis/git/repositories'
    })

    expect(result.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns the response body and never an authorization header', async () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', 'https://dev.azure.com/org')
    vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', 'super-secret-pat')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ count: 1 }), { status: 200 }))
    )

    const result = await executeBoardsProxyRequest({ method: 'GET', path: '/_apis/projects' })

    expect(result).toEqual({ status: 200, body: { count: 1 }, code: null })
    expect(JSON.stringify(result)).not.toContain('super-secret-pat')
    expect(JSON.stringify(result).toLowerCase()).not.toContain('authorization')
    expect(JSON.stringify(result)).not.toContain(
      Buffer.from(':super-secret-pat').toString('base64')
    )
  })

  it.each([
    [401, 'unauthorized'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [409, 'conflict'],
    [418, 'unavailable']
  ] as const)('classifies upstream status %i as %s', async (status, code) => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', 'https://dev.azure.com/org')
    vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', 'super-secret-pat')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: 'nope' }), { status }))
    )

    const result = await executeBoardsProxyRequest({
      method: 'GET',
      path: '/_apis/wit/workitems/1'
    })

    expect(result).toMatchObject({ status, code })
  })

  it('classifies a refused path as forbidden without any fetch', async () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', 'https://dev.azure.com/org')
    vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', 'super-secret-pat')

    const result = await executeBoardsProxyRequest({
      method: 'GET',
      path: '/_apis/git/repositories'
    })

    expect(result).toMatchObject({ status: 403, code: 'forbidden' })
  })

  it('classifies a rejected request shape as validation', async () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', 'https://dev.azure.com/org')
    vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', 'super-secret-pat')

    const result = await executeBoardsProxyRequest({
      method: 'GET',
      path: '../_apis/wit/workitems/1'
    })

    expect(result).toMatchObject({ status: 400, code: 'validation' })
  })

  it('sends a request with no organization to the only configured base URL', async () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', 'https://dev.azure.com/contoso-labs')
    vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', 'super-secret-pat')
    const fetchMock = vi.fn(
      async (_url: string | URL) => new Response(JSON.stringify({ count: 1 }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await executeBoardsProxyRequest({ method: 'GET', path: '/_apis/projects' })

    expect(result).toMatchObject({ status: 200, code: null })
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      'https://dev.azure.com/contoso-labs/_apis/projects'
    )
  })

  it('sends a request with no organization to the first entry of a configured list', async () => {
    vi.stubEnv(
      'ORCA_AZURE_DEVOPS_API_BASE_URL',
      'https://dev.azure.com/contoso-labs, https://dev.azure.com/FabrikamOps'
    )
    vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', 'super-secret-pat')
    const fetchMock = vi.fn(
      async (_url: string | URL) => new Response(JSON.stringify({ count: 1 }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    await executeBoardsProxyRequest({ method: 'GET', path: '/_apis/projects' })

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      'https://dev.azure.com/contoso-labs/_apis/projects'
    )
  })

  it.each([
    ['contoso-labs', 'https://dev.azure.com/contoso-labs/_apis/projects'],
    ['FabrikamOps', 'https://dev.azure.com/FabrikamOps/_apis/projects'],
    ['FABRIKAMOPS', 'https://dev.azure.com/FabrikamOps/_apis/projects']
  ])('sends organization %s to its own configured base URL', async (organization, expected) => {
    vi.stubEnv(
      'ORCA_AZURE_DEVOPS_API_BASE_URL',
      'https://dev.azure.com/contoso-labs,https://dev.azure.com/FabrikamOps'
    )
    vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', 'super-secret-pat')
    const fetchMock = vi.fn(
      async (_url: string | URL) => new Response(JSON.stringify({ count: 1 }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await executeBoardsProxyRequest({
      method: 'GET',
      path: '/_apis/projects',
      organization
    })

    expect(result).toMatchObject({ status: 200, code: null })
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(expected)
  })

  it('refuses an unconfigured organization as validation without any fetch', async () => {
    vi.stubEnv(
      'ORCA_AZURE_DEVOPS_API_BASE_URL',
      'https://dev.azure.com/contoso-labs,https://dev.azure.com/FabrikamOps'
    )
    vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', 'super-secret-pat')
    const fetchMock = vi.fn(
      async (_url: string | URL) => new Response(JSON.stringify({ count: 1 }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await executeBoardsProxyRequest({
      method: 'GET',
      path: '/_apis/projects',
      organization: 'attacker-org'
    })

    expect(result).toMatchObject({ status: 400, code: 'validation' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports not_configured, not validation, when an organization is named but none is set', async () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', '')
    vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', 'super-secret-pat')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await executeBoardsProxyRequest({
      method: 'GET',
      path: '/_apis/projects',
      organization: 'contoso-labs'
    })

    expect(result).toMatchObject({ status: 412, code: 'not_configured' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends a POST as JSON Patch only when the caller asks for that media type', async () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', 'https://dev.azure.com/org')
    vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', 'super-secret-pat')
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: 1 }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    await executeBoardsProxyRequest({
      method: 'POST',
      path: '/proj/_apis/wit/workitems/$Bug',
      body: [{ op: 'add', path: '/fields/System.Title', value: 'Crash' }],
      contentType: 'application/json-patch+json'
    })
    await executeBoardsProxyRequest({
      method: 'POST',
      path: '/_apis/wit/wiql',
      body: { query: 'SELECT [System.Id] FROM WorkItems' }
    })

    expect(contentTypeOf(fetchMock.mock.calls[0]?.[1])).toBe('application/json-patch+json')
    expect(contentTypeOf(fetchMock.mock.calls[1]?.[1])).toBe('application/json')
  })

  it('reports a failed upstream call as unavailable rather than empty data', async () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', 'https://dev.azure.com/org')
    vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', 'super-secret-pat')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      })
    )

    const result = await executeBoardsProxyRequest({ method: 'GET', path: '/_apis/projects' })

    expect(result).toEqual({
      status: 503,
      body: { message: 'Azure DevOps request failed' },
      code: 'unavailable'
    })
  })
})
