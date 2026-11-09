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

async function cloudApiErrorOf(promise: Promise<unknown>): Promise<CloudApiError> {
  const caught = await promise.then(
    () => null,
    (error: unknown) => error
  )
  if (!(caught instanceof CloudApiError)) {
    throw new Error(`expected a CloudApiError, got ${String(caught)}`)
  }
  return caught
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
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      respond(200, { keys: [KEY], availableScopes: ['audit:read'] })
    )
    const keys = await client(fetchImpl).listApiKeys()
    expect(keys.keys[0]?.prefix).toBe('orca_sk_Ab3x')
    // Unknown scopes from a newer server are dropped, not fatal.
    expect(keys.keys[0]?.scopes).toEqual(['workspaces:read'])
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://cp.example.dev/v1/api-keys')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok_secret')
    expect(init?.redirect).toBe('error')

    const created = vi.fn<typeof fetch>(async () =>
      respond(201, { key: KEY, secret: `orca_sk_${'a'.repeat(32)}` })
    )
    await client(created).createApiKey({
      name: 'CI',
      scopes: ['workspaces:read']
    })
    const [, createInit] = created.mock.calls[0] ?? []
    expect(createInit?.method).toBe('POST')
    expect(JSON.parse(String(createInit?.body))).toEqual({
      name: 'CI',
      scopes: ['workspaces:read']
    })

    const runs = vi.fn<typeof fetch>(async () => respond(200, { runs: [], nextBefore: null }))
    await client(runs).listRoutineRuns('rt/1', { limit: 20, before: 99 })
    expect(runs.mock.calls[0]?.[0]).toBe(
      'https://cp.example.dev/v1/routines/rt%2F1/runs?limit=20&before=99'
    )
  })

  it('rejects a malformed answer as invalid-response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => respond(200, { keys: 'nope' }))
    expect(await codeOf(client(fetchImpl).listApiKeys())).toBe('invalid-response')
    const badSecret = vi.fn<typeof fetch>(async () =>
      respond(201, { key: KEY, secret: 'not-a-key' })
    )
    expect(
      await codeOf(
        client(badSecret).createApiKey({
          name: 'x',
          scopes: ['audit:read']
        })
      )
    ).toBe('invalid-response')
  })

  it('maps network and token failures without leaking the token', async () => {
    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed tok_secret')
    })
    const error = await cloudApiErrorOf(client(offline).me())
    expect(error.code).toBe('network')
    expect(error.message).not.toContain('tok_secret')

    const noToken = client(vi.fn<typeof fetch>(), async () => {
      throw new Error('signed out')
    })
    expect(await codeOf(noToken.me())).toBe('signed-out')
  })

  it('treats a missing routines route as not-available but a missing routine as not-found', async () => {
    const missing = vi.fn<typeof fetch>(async () => respond(404, { error: 'not_found' }))
    const c = client(missing)
    expect(await codeOf(c.listRoutines())).toBe('not-available')
    expect(await codeOf(c.getRoutine('rt_1'))).toBe('not-found')
  })

  it('carries retry-after on rate limits and accepts empty DELETE bodies', async () => {
    const limited = vi.fn<typeof fetch>(async () =>
      respond(429, { error: 'rate_limited' }, { 'retry-after': '7' })
    )
    const error = await cloudApiErrorOf(client(limited).listApiKeys())
    expect(error.code).toBe('rate-limited')
    expect(error.retryAfterSeconds).toBe(7)

    const deleted = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }))
    await expect(client(deleted).revokeApiKey('key_1')).resolves.toBeUndefined()
  })
})

describe('teammate names', () => {
  it('accepts optional names and degrades a bad one to null', async () => {
    const named = { ...KEY, createdByName: 'Ada Lovelace' }
    const bad = { ...KEY, id: 'key_2', createdByName: 42 }
    const legacy = { ...KEY, id: 'key_3' }
    const fetchImpl = vi.fn(async () =>
      respond(200, { keys: [named, bad, legacy], availableScopes: [] })
    )
    const { keys } = await client(fetchImpl as unknown as typeof fetch).listApiKeys()
    expect(keys.map((key) => key.createdByName)).toEqual(['Ada Lovelace', null, undefined])
  })

  it('reads audit actor names', async () => {
    const entry = {
      id: 'a1',
      actor: { type: 'user', id: 'u_ada', userId: 'u_ada', userName: 'Ada Lovelace' },
      action: 'api_key.create',
      target: null,
      createdAt: 1
    }
    const fetchImpl = vi.fn(async () => respond(200, { entries: [entry], nextBefore: null }))
    const page = await client(fetchImpl as unknown as typeof fetch).listAudit()
    expect(page.entries[0]?.actor.userName).toBe('Ada Lovelace')
  })
})

describe('response hardening', () => {
  it('keeps a freshly minted secret even if the key metadata drifted', async () => {
    const secret = `orca_sk_${'b'.repeat(32)}`
    const fetchImpl = vi.fn<typeof fetch>(async () => respond(201, { key: { id: 7 }, secret }))
    const created = await client(fetchImpl).createApiKey({
      name: 'x',
      scopes: ['workspaces:read']
    })
    expect(created).toEqual({ key: null, secret })
  })

  it('drops non-https links from the server', async () => {
    const run = {
      id: 'run_1',
      routineId: 'rt_1',
      trigger: 'manual',
      triggerDetail: null,
      status: 'succeeded',
      workspaceId: null,
      result: { prUrl: 'javascript:alert(1)' },
      error: null,
      createdAt: 1,
      startedAt: 1,
      finishedAt: 2,
      durationMs: 1
    }
    const fetchImpl = vi.fn<typeof fetch>(async () => respond(202, { run }))
    // A bad link is dropped, never opened, and doesn't fail the whole response.
    const { run: parsed } = await client(fetchImpl).runRoutine('rt_1')
    expect(parsed.result?.prUrl).toBeUndefined()
    expect(parsed.status).toBe('succeeded')
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
