import { describe, expect, it, vi } from 'vitest'
import { CloudApiError, classifyCloudApiResponse, createCloudApiClient } from './cloud-api-client'

const KEY = {
  id: 'key_1',
  name: 'CI',
  prefix: 'orca_sk_Ab3x',
  scopes: ['workspaces:read', 'future:scope'],
  createdBy: 'u1',
  createdAt: 1,
  lastUsedAt: null,
  expiresAt: null
}

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
}

function client(fetchImpl: typeof fetch, getAccessToken = async () => 'tok_secret') {
  return createCloudApiClient({
    controlPlaneUrl: 'https://cp.example.dev/',
    getAccessToken,
    fetchImpl
  })
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof CloudApiError) {
      return error.code
    }
    throw error
  }
  return 'ok'
}

describe('createCloudApiClient', () => {
  it('sends the bearer token, JSON body and query, and validates the answer', async () => {
    const fetchImpl = vi.fn(async () =>
      respond(200, { keys: [KEY], availableScopes: ['audit:read'] })
    )
    const keys = await client(fetchImpl as unknown as typeof fetch).listApiKeys()
    expect(keys.keys[0]?.prefix).toBe('orca_sk_Ab3x')
    // Unknown scopes from a newer server are dropped, not fatal.
    expect(keys.keys[0]?.scopes).toEqual(['workspaces:read'])
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://cp.example.dev/v1/api-keys')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok_secret')
    expect(init.redirect).toBe('error')

    const created = vi.fn(async () =>
      respond(201, { key: KEY, secret: `orca_sk_${'a'.repeat(32)}` })
    )
    await client(created as unknown as typeof fetch).createApiKey({
      name: 'CI',
      scopes: ['workspaces:read']
    })
    const [, createInit] = created.mock.calls[0] as unknown as [string, RequestInit]
    expect(createInit.method).toBe('POST')
    expect(JSON.parse(String(createInit.body))).toEqual({ name: 'CI', scopes: ['workspaces:read'] })

    const runs = vi.fn(async () => respond(200, { runs: [], nextBefore: null }))
    await client(runs as unknown as typeof fetch).listRoutineRuns('rt/1', { limit: 20, before: 99 })
    expect((runs.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://cp.example.dev/v1/routines/rt%2F1/runs?limit=20&before=99'
    )
  })

  it('rejects a malformed answer as invalid-response', async () => {
    const fetchImpl = vi.fn(async () => respond(200, { keys: 'nope' }))
    expect(await codeOf(client(fetchImpl as unknown as typeof fetch).listApiKeys())).toBe(
      'invalid-response'
    )
    const badSecret = vi.fn(async () => respond(201, { key: KEY, secret: 'not-a-key' }))
    expect(
      await codeOf(
        client(badSecret as unknown as typeof fetch).createApiKey({
          name: 'x',
          scopes: ['audit:read']
        })
      )
    ).toBe('invalid-response')
  })

  it('maps network and token failures without leaking the token', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed tok_secret')
    })
    const error = await client(offline as unknown as typeof fetch)
      .me()
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CloudApiError)
    expect((error as CloudApiError).code).toBe('network')
    expect(String((error as CloudApiError).message)).not.toContain('tok_secret')

    const noToken = client(vi.fn() as unknown as typeof fetch, async () => {
      throw new Error('signed out')
    })
    expect(await codeOf(noToken.me())).toBe('signed-out')
  })

  it('treats a missing routines route as not-available but a missing routine as not-found', async () => {
    const missing = vi.fn(async () => respond(404, { error: 'not_found' }))
    const c = client(missing as unknown as typeof fetch)
    expect(await codeOf(c.listRoutines())).toBe('not-available')
    expect(await codeOf(c.getRoutine('rt_1'))).toBe('not-found')
  })

  it('carries retry-after on rate limits and accepts empty DELETE bodies', async () => {
    const limited = vi.fn(async () =>
      respond(429, { error: 'rate_limited' }, { 'retry-after': '7' })
    )
    const error = (await client(limited as unknown as typeof fetch)
      .listApiKeys()
      .catch((caught: unknown) => caught)) as CloudApiError
    expect(error.code).toBe('rate-limited')
    expect(error.retryAfterSeconds).toBe(7)

    const deleted = vi.fn(async () => new Response(null, { status: 200 }))
    await expect(
      client(deleted as unknown as typeof fetch).revokeApiKey('key_1')
    ).resolves.toBeUndefined()
  })
})

describe('classifyCloudApiResponse', () => {
  it.each([
    [401, { error: 'unauthorized' }, 'signed-out'],
    [403, { error: 'forbidden', reason: 'admin_required' }, 'admin-required'],
    [403, { error: 'forbidden', reason: 'admin_scope:audit:read' }, 'admin-required'],
    [403, { error: 'insufficient_scope', reason: 'routines:write' }, 'forbidden'],
    [400, { error: 'invalid_request', reason: 'name: Too small' }, 'invalid-request'],
    [503, { error: 'not_configured' }, 'not-available'],
    [500, null, 'server'],
    [502, { error: 'workspace_unavailable' }, 'server']
  ])('%i %j → %s', (status, body, code) => {
    expect(classifyCloudApiResponse(status, body).code).toBe(code)
  })

  it('keeps the server validation reason as detail, truncated', () => {
    expect(classifyCloudApiResponse(400, { reason: 'name: Too small' }).detail).toBe(
      'name: Too small'
    )
    expect(classifyCloudApiResponse(400, { reason: 'x'.repeat(1000) }).detail).toHaveLength(200)
  })
})
