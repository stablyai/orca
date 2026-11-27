import { afterEach, describe, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../network/http-client'

vi.mock('./instance-credential-store', () => ({
  readItsaplanInstance: () => ({
    id: 'inst1',
    appUrl: 'https://app.example.com',
    apiUrl: 'https://api.example.com'
  }),
  readItsaplanApiKey: () => 'secret-key-k'
}))

import {
  classifyItsaplanResponse,
  itsaplanRequest,
  ItsaplanApiError,
  verifyItsaplanKey
} from './client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

afterEach(() => setMainHttpClient(null))

describe('classifyItsaplanResponse', () => {
  it('maps statuses to failure codes', () => {
    expect(classifyItsaplanResponse(401)).toBe('invalidApiKey')
    expect(classifyItsaplanResponse(403)).toBe('forbidden')
    expect(classifyItsaplanResponse(404)).toBe('notFound')
    expect(classifyItsaplanResponse(429)).toBe('rateLimited')
    expect(classifyItsaplanResponse(500)).toBe('requestFailed')
  })
})

describe('verifyItsaplanKey', () => {
  it('treats authenticated:false as an invalid key', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double implements only the fetch surface the code under test reads.
    const fetchImpl = (async () =>
      jsonResponse({ authenticated: false })) as unknown as typeof fetch
    expect(await verifyItsaplanKey('https://api.example.com', 'k', fetchImpl)).toMatchObject({
      ok: false,
      error: 'invalidApiKey'
    })
  })

  it('returns the viewer when authenticated', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double implements only the fetch surface the code under test reads.
    const fetchImpl = (async () =>
      jsonResponse({
        authenticated: true,
        user: { id: 'u1', name: 'Ana', email: null }
      })) as unknown as typeof fetch
    expect(await verifyItsaplanKey('https://api.example.com', 'k', fetchImpl)).toEqual({
      ok: true,
      viewer: { id: 'u1', name: 'Ana', email: null }
    })
  })
})

describe('itsaplanRequest', () => {
  it('sends x-api-key and keeps the key out of a 401 error', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'nope' }, 401))
    setMainHttpClient({ fetch: fetchMock, proxySession: () => null })

    const error = await itsaplanRequest('/issues/1').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ItsaplanApiError)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the caught value is the error thrown by the call under test.
    expect((error as ItsaplanApiError).code).toBe('invalidApiKey')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the caught value is the error thrown by the call under test.
    expect((error as Error).message).toBe('invalidApiKey: API key invalid, reconnect.')
    expect(JSON.stringify(error)).not.toContain('secret-key-k')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: vitest types mock calls loosely; the mock is called with (url, init).
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.example.com/issues/1')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the client always sends a plain headers record.
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('secret-key-k')
  })

  it('joins array query values with commas', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]))
    setMainHttpClient({ fetch: fetchMock, proxySession: () => null })

    await itsaplanRequest('/projects/t.K/issues', { query: { labelIds: [1, 2], limit: 5 } })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: vitest types mock calls loosely; the mock is called with (url).
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://api.example.com/projects/t.K/issues?labelIds=1%2C2&limit=5'
    )
  })

  it('refuses redirects so the key never follows one', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]))
    setMainHttpClient({ fetch: fetchMock, proxySession: () => null })

    await itsaplanRequest('/projects')

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: vitest types mock calls loosely; the mock is called with (url, init).
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.redirect).toBe('error')
  })

  it('reports a redirect as requestFailed', async () => {
    setMainHttpClient({
      fetch: async () => {
        throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') })
      },
      proxySession: () => null
    })
    const error = await itsaplanRequest('/projects').catch((caught: unknown) => caught)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the caught value is the error thrown by the call under test.
    expect((error as ItsaplanApiError).code).toBe('requestFailed')
  })
})
