import { describe, expect, it, vi } from 'vitest'
import { EnvironmentProviderError } from '../../environment-providers/environment-provider-driver'
import {
  createHostedEnvironmentClient,
  HostedEnvironmentRequestError
} from './hosted-environment-client'
import { toHostedEnvironmentError } from './hosted-environment-service'
import {
  BUILD_ID,
  ENV_ID,
  buildView,
  environmentEntry
} from './hosted-environment-fixtures.test-support'

const BASE = 'https://control.example.test'

function client(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: URL, init: RequestInit) => handler(new URL(input), init))
  return {
    fetchMock,
    client: createHostedEnvironmentClient({
      baseUrl: BASE,
      getAccessToken: async () => 'tok',
      fetch: fetchMock
    })
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('createHostedEnvironmentClient', () => {
  it('lists environments with the bearer token and never follows redirects', async () => {
    const { client: c, fetchMock } = client(() =>
      json({ environments: [{ ...environmentEntry(), futureField: 1 }], canAdmin: true })
    )
    const result = await c.list()
    expect(result.canAdmin).toBe(true)
    expect(result.environments[0].name).toBe('Web')
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(`${BASE}/v1/environments`)
    expect(init?.redirect).toBe('manual')
    expect(init?.headers).toMatchObject({ authorization: 'Bearer tok' })
  })

  it('maps each route to its method and path', async () => {
    const calls: string[] = []
    const { client: c } = client((url, init) => {
      calls.push(`${init.method} ${url.pathname}${url.search}`)
      if (url.pathname.endsWith('/staleness')) {
        return json({
          staleness: {
            checkedAt: 1,
            activeBuildId: null,
            configChanged: false,
            recommendation: 'something_new',
            repos: []
          }
        })
      }
      if (
        url.pathname.endsWith('/activate') ||
        init.method === 'PATCH' ||
        (init.method === 'POST' && url.pathname === '/v1/environments')
      ) {
        return json({ environment: environmentEntry() })
      }
      if (init.method === 'DELETE') {
        return json({ deleted: true })
      }
      if (url.pathname.includes('/builds')) {
        return json({ build: buildView() })
      }
      return json({ environment: environmentEntry(), builds: [buildView()], canAdmin: false })
    })
    await c.get(ENV_ID)
    await c.create({ name: 'Web', repos: [{ url: 'acme/web' }] })
    await c.update(ENV_ID, { installScript: 'x', expectedRevision: 2 })
    await c.remove(ENV_ID)
    await c.startBuild(ENV_ID)
    await c.getBuild(ENV_ID, BUILD_ID)
    await c.cancelBuild(ENV_ID, BUILD_ID)
    await c.activateBuild(ENV_ID, BUILD_ID)
    const staleness = await c.staleness(ENV_ID, true)
    expect(staleness.recommendation).toBe('unknown')
    expect(calls).toEqual([
      `GET /v1/environments/${ENV_ID}`,
      'POST /v1/environments',
      `PATCH /v1/environments/${ENV_ID}`,
      `DELETE /v1/environments/${ENV_ID}`,
      `POST /v1/environments/${ENV_ID}/builds`,
      `GET /v1/environments/${ENV_ID}/builds/${BUILD_ID}`,
      `POST /v1/environments/${ENV_ID}/builds/${BUILD_ID}/cancel`,
      `POST /v1/environments/${ENV_ID}/builds/${BUILD_ID}/activate`,
      `GET /v1/environments/${ENV_ID}/staleness?refresh=1`
    ])
  })

  it('refuses ids that could change the path', async () => {
    const { client: c, fetchMock } = client(() => json({}))
    await expect(c.get('env_../../v1/sandboxes')).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(c.cancelBuild(ENV_ID, 'bld_x/../y')).rejects.toMatchObject({
      code: 'invalid_request'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps control-plane refusals to friendly errors', async () => {
    const { client: c } = client(() => json({ error: 'conflict', reason: 'stale_revision' }, 409))
    const error = await c.update(ENV_ID, { installScript: 'x' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HostedEnvironmentRequestError)
    expect(toHostedEnvironmentError(error)).toEqual({
      code: 'conflict',
      reason: 'stale_revision',
      message: 'Someone else saved changes. Reload to see them.'
    })
    const admin = createHostedEnvironmentClient({
      baseUrl: BASE,
      getAccessToken: async () => 'tok',
      fetch: async () => json({ error: 'forbidden', reason: 'admin_required' }, 403)
    })
    expect(
      toHostedEnvironmentError(await admin.startBuild(ENV_ID).catch((e: unknown) => e))
    ).toMatchObject({
      message: 'Only owners and admins can change the environment. Ask an owner or admin.'
    })
  })

  it('treats redirects, oversized and malformed bodies as errors', async () => {
    const redirect = client(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.test' } })
    )
    await expect(redirect.client.list()).rejects.toMatchObject({ code: 'invalid_response' })
    const huge = client(() => new Response('x'.repeat(3 * 1024 * 1024)))
    await expect(huge.client.list()).rejects.toMatchObject({ code: 'invalid_response' })
    const wrong = client(() => json({ environments: 'nope' }))
    await expect(wrong.client.list()).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('reports sign-in problems from token minting', async () => {
    const c = createHostedEnvironmentClient({
      baseUrl: BASE,
      getAccessToken: async () => {
        throw new EnvironmentProviderError('unauthorized', 'Sign in to Orca to use Orca Cloud.')
      },
      fetch: async () => json({})
    })
    expect(toHostedEnvironmentError(await c.list().catch((e: unknown) => e))).toMatchObject({
      code: 'unauthorized',
      message: 'Sign in to Orca to use Orca Cloud.'
    })
  })

  it('requires an https control plane', () => {
    expect(() =>
      createHostedEnvironmentClient({
        baseUrl: 'http://control.example.test',
        getAccessToken: async () => ''
      })
    ).toThrow(/HTTPS/)
  })
})
