import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeBoardsProxyRequest } from './boards-proxy'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('executeBoardsProxyRequest', () => {
  it('reports not_configured when no base url is set', async () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', '')

    const result = await executeBoardsProxyRequest({ method: 'GET', path: '/_apis/projects' })

    expect(result).toMatchObject({ status: 412 })
  })

  it('reports not_configured when a base url is set but no credentials are configured', async () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', 'https://dev.azure.com/org')
    vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', '')
    vi.stubEnv('ORCA_AZURE_DEVOPS_PAT', '')
    vi.stubEnv('ORCA_AZURE_DEVOPS_ACCESS_TOKEN', '')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await executeBoardsProxyRequest({ method: 'GET', path: '/_apis/projects' })

    expect(result.status).toBe(412)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports not_configured, not 503, when the base url has no scheme', async () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', 'dev.azure.com/org')
    vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', 'super-secret-pat')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await executeBoardsProxyRequest({ method: 'GET', path: '/_apis/projects' })

    expect(result.status).toBe(412)
    expect(fetchMock).not.toHaveBeenCalled()
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

    expect(result).toEqual({ status: 200, body: { count: 1 } })
    expect(JSON.stringify(result)).not.toContain('super-secret-pat')
    expect(JSON.stringify(result).toLowerCase()).not.toContain('authorization')
    expect(JSON.stringify(result)).not.toContain(
      Buffer.from(':super-secret-pat').toString('base64')
    )
  })

  it.each([
    [401, 'unauthorized'],
    [404, 'a missing work item'],
    [429, 'a throttle']
  ])('passes status %i through so the plugin can report %s', async (status) => {
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

    expect(result.status).toBe(status)
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

    expect(result).toEqual({ status: 503, body: { message: 'Azure DevOps request failed' } })
  })
})
