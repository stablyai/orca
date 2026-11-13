import { describe, expect, it } from 'vitest'
import { cloudSecretsFailureCode, createCloudSecretsClient } from './cloud-secrets-client'

type Seen = { method: string; url: string; body: string | null; authorization: string | null }

function fakeControlPlane(respond: (seen: Seen) => Response) {
  const seen: Seen[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const request: Seen = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : null,
      authorization: new Headers(init?.headers).get('authorization')
    }
    seen.push(request)
    return respond(request)
  }
  const client = createCloudSecretsClient({
    baseUrl: 'https://control.test',
    getAccessToken: async () => 'tok',
    fetch: fetchImpl
  })
  return { client, seen }
}

const VIEW = {
  scope: 'repo',
  name: 'DATABASE_URL',
  kind: 'env',
  hint: 'ab12',
  updatedAt: 5,
  updatedBy: 'u1',
  repo: 'github.com/acme/app'
}

describe('createCloudSecretsClient', () => {
  it('re-mints once on 401 stale_token (admin write window), and not for other 401s', async () => {
    const tokens = ['old', 'new']
    let invalidated = 0
    const seen: string[] = []
    let answers: Response[] = []
    const client = createCloudSecretsClient({
      baseUrl: 'https://control.test',
      getAccessToken: async () => tokens[Math.min(invalidated, 1)]!,
      invalidateAccessToken: () => {
        invalidated++
      },
      fetch: async (_input, init) => {
        seen.push(new Headers(init?.headers).get('authorization') ?? '')
        return answers.shift()!
      }
    })
    answers = [
      Response.json({ error: 'unauthorized', reason: 'stale_token' }, { status: 401 }),
      Response.json({ secret: VIEW })
    ]
    await client.put({ scope: 'org' }, 'DATABASE_URL', 'value-not-logged')
    expect(seen).toEqual(['Bearer old', 'Bearer new'])
    expect(invalidated).toBe(1)

    answers = [
      Response.json({ error: 'unauthorized', reason: 'stale_token' }, { status: 401 }),
      Response.json({ error: 'unauthorized', reason: 'stale_token' }, { status: 401 })
    ]
    await expect(client.remove({ scope: 'org' }, 'DATABASE_URL')).rejects.toThrow()
    expect(invalidated).toBe(2)

    answers = [Response.json({ error: 'unauthorized' }, { status: 401 })]
    await expect(client.remove({ scope: 'org' }, 'DATABASE_URL')).rejects.toThrow()
    expect(invalidated).toBe(2)
  })

  it('reads who owns a sandbox and whether it is shared, failing closed on an unknown owner', async () => {
    const answers = [
      { owner: { userId: 'u2', displayName: 'Ada', isCaller: false }, sharedWorkspace: true },
      { owner: { userId: 'u1', displayName: 'Me', isCaller: true }, sharedWorkspace: false },
      { owner: null, sharedWorkspace: true },
      { owner: null }
    ]
    const { client, seen } = fakeControlPlane(() => Response.json(answers.shift()))
    expect(await client.workspaceSharing('sbx 1')).toEqual({
      shared: true,
      ownerName: 'Ada',
      isOwner: false
    })
    expect(await client.workspaceSharing('sbx')).toEqual({
      shared: false,
      ownerName: null,
      isOwner: true
    })
    expect((await client.workspaceSharing('sbx')).isOwner).toBe(false)
    expect((await client.workspaceSharing('sbx')).isOwner).toBe(true)
    expect(seen[0].url).toBe('https://control.test/v1/agent-sources?workspaceId=sbx+1')
  })

  it('addresses scope, name and repo on the wire and sends the value only in the body', async () => {
    const { client, seen } = fakeControlPlane(({ method }) =>
      Response.json(method === 'GET' ? { secrets: [VIEW] } : { secret: VIEW })
    )
    expect(await client.list({ scope: 'repo', repo: 'acme/app' })).toEqual([VIEW])
    await client.put({ scope: 'repo', repo: 'acme/app' }, 'DATABASE_URL', 'postgres://secret')
    expect(seen).toEqual([
      {
        method: 'GET',
        url: 'https://control.test/v1/secrets?scope=repo&repo=acme%2Fapp',
        body: null,
        authorization: 'Bearer tok'
      },
      {
        method: 'PUT',
        url: 'https://control.test/v1/secrets/repo/DATABASE_URL?repo=acme%2Fapp',
        body: '{"value":"postgres://secret"}',
        authorization: 'Bearer tok'
      }
    ])
  })

  it('posts batches and reads partial success', async () => {
    const result = {
      secrets: [{ ...VIEW, scope: 'personal', repo: undefined }],
      deleted: ['OLD'],
      errors: [{ name: 'PATH', error: 'invalid_request', reason: 'reserved_name' }]
    }
    const { client, seen } = fakeControlPlane(() => Response.json(result))
    const out = await client.batch(
      { scope: 'personal' },
      { set: { DATABASE_URL: 'x', PATH: '/bin' }, delete: ['OLD'] }
    )
    expect(out.errors).toEqual([
      { name: 'PATH', error: 'invalid_request', reason: 'reserved_name' }
    ])
    expect(seen[0].url).toBe('https://control.test/v1/secrets/personal/batch')
  })

  it('maps server refusals to their reason and never quotes the request', async () => {
    const { client } = fakeControlPlane(() =>
      Response.json(
        { error: 'invalid_request', reason: 'subscription_token_refused' },
        { status: 400 }
      )
    )
    const error = await client
      .put({ scope: 'personal' }, 'ANTHROPIC_API_KEY', 'sk-ant-oat01-very-secret')
      .catch((caught: unknown) => caught)
    expect(cloudSecretsFailureCode(error)).toBe('subscription_token_refused')
    expect(String(error)).not.toContain('very-secret')
  })

  it.each([
    [403, { error: 'forbidden', reason: 'org_admin_required' }, 'org_admin_required'],
    [409, { error: 'conflict', reason: 'secret_limit' }, 'secret_limit'],
    [401, { error: 'unauthorized' }, 'unauthorized'],
    [503, { error: 'internal_error' }, 'unavailable']
  ])('maps HTTP %i to %s', async (status, body, code) => {
    const { client } = fakeControlPlane(() => Response.json(body, { status }))
    const error = await client.list({ scope: 'org' }).catch((caught: unknown) => caught)
    expect(cloudSecretsFailureCode(error)).toBe(code)
  })

  it('rejects a response that does not match the schema', async () => {
    const { client } = fakeControlPlane(() => Response.json({ secrets: [{ name: 1 }] }))
    const error = await client.list({ scope: 'personal' }).catch((caught: unknown) => caught)
    expect(cloudSecretsFailureCode(error)).toBe('unavailable')
  })

  it('reads the effective view and refreshes a sandbox env', async () => {
    const effective = {
      caller: {
        userId: 'u1',
        orgId: 'org_1',
        orgRole: 'member',
        canWrite: { personal: true, org: false, repo: false }
      },
      precedence: { env: ['repo', 'personal', 'org'], agent_key: ['org', 'repo', 'personal'] },
      secrets: [
        {
          name: 'ANTHROPIC_API_KEY',
          kind: 'agent_key',
          scope: 'org',
          hint: 'zz99',
          updatedAt: 1,
          shadowed: [{ scope: 'personal', hint: null }]
        }
      ]
    }
    const { client, seen } = fakeControlPlane(({ url }) =>
      Response.json(url.includes('/env/refresh') ? { applied: true } : effective)
    )
    expect(await client.effective('acme/app')).toEqual(effective)
    expect(await client.refreshEnv('sbx_1')).toBe(true)
    await client.effective('acme/app', undefined, 'shared')
    await client.effective(undefined, undefined, 'shared')
    await client.effective()
    expect(seen.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET https://control.test/v1/secrets/effective?repo=acme%2Fapp',
      'POST https://control.test/v1/sandboxes/sbx_1/env/refresh',
      'GET https://control.test/v1/secrets/effective?repo=acme%2Fapp&workspace=shared',
      'GET https://control.test/v1/secrets/effective?workspace=shared',
      'GET https://control.test/v1/secrets/effective'
    ])
  })
})
