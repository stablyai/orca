import { describe, expect, it } from 'vitest'
import {
  detectItsaplanApiUrl,
  itsaplanApiUrlCandidates,
  normalizeItsaplanAppUrl
} from './instance-url'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

describe('normalizeItsaplanAppUrl', () => {
  it('adds https, drops the trailing slash and keeps the path', () => {
    expect(normalizeItsaplanAppUrl('plan.example.com/')).toBe('https://plan.example.com')
    expect(normalizeItsaplanAppUrl(' https://example.com/plan/ ')).toBe('https://example.com/plan')
  })

  it('keeps http for local instances and rejects other schemes', () => {
    expect(normalizeItsaplanAppUrl('http://localhost:3000/')).toBe('http://localhost:3000')
    expect(normalizeItsaplanAppUrl('ftp://x')).toBeNull()
    expect(normalizeItsaplanAppUrl('')).toBeNull()
  })
})

describe('itsaplanApiUrlCandidates', () => {
  it('orders /api, root, then the api subdomain', () => {
    expect(itsaplanApiUrlCandidates('https://app.example.com')).toEqual([
      'https://app.example.com/api',
      'https://app.example.com',
      'https://api.app.example.com'
    ])
  })

  it('omits the api subdomain for localhost and IP hosts', () => {
    expect(itsaplanApiUrlCandidates('http://localhost:3000')).toEqual([
      'http://localhost:3000/api',
      'http://localhost:3000'
    ])
    expect(itsaplanApiUrlCandidates('http://10.0.0.5:3000')).toHaveLength(2)
  })
})

describe('detectItsaplanApiUrl', () => {
  it('skips an HTML catch-all and accepts the next JSON probe', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double implements only the fetch surface the code under test reads.
    const fetchImpl = (async (url: string) =>
      url === 'https://app.example.com/api/me'
        ? new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })
        : jsonResponse({ authenticated: false })) as unknown as typeof fetch
    expect(await detectItsaplanApiUrl('app.example.com/', fetchImpl)).toEqual({
      ok: true,
      appUrl: 'https://app.example.com',
      apiUrl: 'https://app.example.com'
    })
  })

  it('reports unreachable when every probe throws', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double implements only the fetch surface the code under test reads.
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    expect(await detectItsaplanApiUrl('https://app.example.com', fetchImpl)).toMatchObject({
      ok: false,
      error: 'unreachable'
    })
  })

  it('reports apiNotFound when probes answer without the me shape', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double implements only the fetch surface the code under test reads.
    const fetchImpl = (async () => jsonResponse({ hello: 1 })) as unknown as typeof fetch
    expect(await detectItsaplanApiUrl('https://app.example.com', fetchImpl)).toMatchObject({
      ok: false,
      error: 'apiNotFound'
    })
  })

  it('reports invalidUrl for unusable input', async () => {
    expect(await detectItsaplanApiUrl('ftp://x')).toMatchObject({
      ok: false,
      error: 'invalidUrl'
    })
  })
})
