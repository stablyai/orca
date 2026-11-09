import { describe, expect, it } from 'vitest'
import { OPERATIONS, openApiDocument } from '../src/api/openapi'
import { createHarness } from './harness'

async function harness() {
  const pending: Promise<unknown>[] = []
  const h = await createHarness({ PUBLIC_API_URL: 'https://api.test' }, { waitUntil: (p) => void pending.push(p) })
  return { ...h, settle: () => Promise.all(pending.splice(0)) }
}

describe('public API: keys', () => {
  it('creates a key once-visible, hashes it at rest, authenticates with it, and revokes it', async () => {
    const h = await harness()
    const created = await h.call('POST', '/v1/api-keys', { body: { name: 'CI', scopes: ['workspaces:read'] } })
    expect(created.status).toBe(201)
    const secret: string = created.body.secret
    expect(secret).toMatch(/^orca_sk_[A-Za-z0-9]{32}$/)
    expect(created.body.key.prefix).toBe(secret.slice(0, 12))
    const stored = h.raw.prepare('SELECT secret_hash, prefix FROM api_keys').all() as { secret_hash: string }[]
    expect(JSON.stringify(stored)).not.toContain(secret)

    const me = await h.call('GET', '/v1/me', { bearer: secret })
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ accountId: 'user:alice', via: 'user', scopes: ['workspaces:read'] })
    expect((await h.call('GET', '/v1/workspaces', { bearer: secret })).status).toBe(200)
    // Scope is enforced.
    expect((await h.call('GET', '/v1/projects', { bearer: secret })).body).toEqual({ error: 'insufficient_scope', reason: 'projects:read' })
    // Keys cannot mint keys.
    expect((await h.call('POST', '/v1/api-keys', { bearer: secret, body: { name: 'x', scopes: ['workspaces:read'] } })).status).toBe(403)

    const listed = await h.call('GET', '/v1/api-keys')
    expect(listed.body.keys).toHaveLength(1)
    expect(JSON.stringify(listed.body)).not.toContain(secret)

    expect((await h.call('DELETE', `/v1/api-keys/${created.body.key.id}`)).status).toBe(200)
    expect((await h.call('GET', '/v1/me', { bearer: secret })).status).toBe(401)
    const audit = await h.call('GET', '/v1/audit')
    expect(audit.body.entries.map((e: { action: string }) => e.action)).toEqual(['api_key.revoke', 'api_key.create'])
  })

  it('keeps org members from granting admin scopes or reading the audit log', async () => {
    const h = await harness()
    const member = await h.token('bob', 'acme', 'sandbox', { orgRole: 'member' })
    expect((await h.call('POST', '/v1/api-keys', { bearer: member, body: { name: 'x', scopes: ['audit:read'] } })).status).toBe(403)
    expect((await h.call('GET', '/v1/audit', { bearer: member })).status).toBe(403)
    const admin = await h.token('carol', 'acme', 'sandbox', { orgRole: 'admin' })
    const key = await h.call('POST', '/v1/api-keys', { bearer: admin, body: { name: 'audit', scopes: ['audit:read'] } })
    expect(key.status).toBe(201)
    // Members only see their own keys; admins see the org's.
    await h.call('POST', '/v1/api-keys', { bearer: member, body: { name: 'mine', scopes: ['workspaces:read'] } })
    expect((await h.call('GET', '/v1/api-keys', { bearer: member })).body.keys.map((k: { name: string }) => k.name)).toEqual(['mine'])
    expect((await h.call('GET', '/v1/api-keys', { bearer: admin })).body.keys).toHaveLength(2)
    // Another org never sees them.
    const other = await h.token('dave', 'globex', 'sandbox', { orgRole: 'owner' })
    expect((await h.call('GET', '/v1/api-keys', { bearer: other })).body.keys).toHaveLength(0)
    expect((await h.call('DELETE', `/v1/api-keys/${key.body.key.id}`, { bearer: other })).status).toBe(404)
  })

  it('rate limits per key and reports the window in headers', async () => {
    const h = await harness()
    const { secret } = (await h.call('POST', '/v1/api-keys', { body: { name: 'CI', scopes: ['workspaces:read'] } })).body
    let last: Response | null = null
    for (let i = 0; i < 121; i++) {
      last = await h.send(new Request('https://sandbox.test/v1/me', { headers: { authorization: `Bearer ${secret}` } }))
    }
    expect(last!.status).toBe(429)
    expect(last!.headers.get('retry-after')).toBeTruthy()
    h.advance(60_000)
    const ok = await h.send(new Request('https://sandbox.test/v1/me', { headers: { authorization: `Bearer ${secret}` } }))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('x-ratelimit-remaining')).toBe('119')
  })
})

describe('public API: workspaces', () => {
  it('creates, sleeps, wakes, archives and destroys through the API with audit entries', async () => {
    const h = await harness()
    const { secret } = (await h.call('POST', '/v1/api-keys', { body: { name: 'CI', scopes: ['workspaces:read', 'workspaces:write', 'projects:write', 'projects:read'] } })).body
    const project = await h.call('POST', '/v1/projects', { bearer: secret, body: { name: 'app', repo: { url: 'https://github.com/acme/app' } } })
    expect(project.status).toBe(201)
    const created = await h.call('POST', '/v1/workspaces', { bearer: secret, body: { name: 'fix', projectId: project.body.project.id } })
    expect(created.status).toBe(201)
    const ws = created.body.workspace
    expect(ws).toMatchObject({ name: 'fix', status: 'running', origin: 'api', projectId: project.body.project.id, repoUrl: 'https://github.com/acme/app' })
    expect((await h.call('POST', `/v1/workspaces/${ws.id}/sleep`, { bearer: secret })).body.workspace.status).toBe('sleeping')
    expect((await h.call('POST', `/v1/workspaces/${ws.id}/wake`, { bearer: secret })).body.workspace.status).toBe('running')
    const archived = await h.call('POST', `/v1/workspaces/${ws.id}/archive`, { bearer: secret })
    expect(archived.body.workspace).toMatchObject({ status: 'sleeping', archived: true })
    expect((await h.call('GET', '/v1/workspaces', { bearer: secret })).body.workspaces).toHaveLength(0)
    expect((await h.call('GET', '/v1/workspaces?include=archived', { bearer: secret })).body.workspaces).toHaveLength(1)
    expect((await h.call('DELETE', `/v1/workspaces/${ws.id}`, { bearer: secret })).body.workspace.status).toBe('destroyed')
    expect((await h.call('GET', `/v1/workspaces/${ws.id}`, { bearer: secret })).status).toBe(404)
    const actions = (await h.call('GET', '/v1/audit')).body.entries.map((e: { action: string }) => e.action)
    expect(actions).toEqual(['workspace.destroy', 'workspace.archive', 'workspace.wake', 'workspace.sleep', 'workspace.create', 'project.create', 'api_key.create'])
  })

  it('hides another account and machine-made workspaces', async () => {
    const h = await harness()
    const created = await h.call('POST', '/v1/workspaces', { body: { name: 'mine' } })
    expect((await h.call('GET', `/v1/workspaces/${created.body.workspace.id}`, { as: 'mallory' })).status).toBe(404)
    expect((await h.call('POST', `/v1/workspaces/${created.body.workspace.id}/sleep`, { as: 'mallory' })).status).toBe(404)
    h.raw.prepare('UPDATE sandboxes SET hidden = 1').run()
    expect((await h.call('GET', '/v1/workspaces')).body.workspaces).toHaveLength(0)
    expect((await h.call('GET', '/v1/workspaces?include=hidden')).body.workspaces).toHaveLength(1)
    // The desktop's own list never shows hidden ones either.
    expect((await h.call('GET', '/v1/sandboxes')).body.sandboxes).toHaveLength(0)
  })

  it('queues a message, wakes a sleeping workspace and delivers it through the in-VM orca CLI', async () => {
    const h = await harness()
    const ws = (await h.call('POST', '/v1/workspaces', { body: {} })).body.workspace
    await h.call('POST', `/v1/workspaces/${ws.id}/sleep`)
    h.vercel.commandHandler = (params) => {
      const args = params.args ?? []
      if (args.includes('agent')) {
        return { exitCode: 0, stdout: JSON.stringify({ ok: true, result: { outcome: { kind: 'terminal', handle: 'term_abc' } } }), stderr: '' }
      }
      return undefined
    }
    const sent = await h.call('POST', `/v1/workspaces/${ws.id}/messages`, { body: { text: 'fix the bug; rm -rf / "$(x)"' } })
    expect(sent.status).toBe(202)
    expect(sent.body.message.status).toBe('queued')
    await h.settle()
    const status = await h.call('GET', `/v1/workspaces/${ws.id}/messages/${sent.body.message.id}`)
    expect(status.body.message).toMatchObject({ status: 'delivered', session: 'term_abc' })
    expect((await h.call('GET', `/v1/workspaces/${ws.id}`)).body.workspace.status).toBe('running')
    // The text travelled as one argv entry after the fixed script, never through a shell string.
    const launch = h.vercel.commands.find((c) => c.args?.includes('agent'))!
    expect(launch.command).toBe('/bin/sh')
    expect(launch.args!.at(-1)).toBe('fix the bug; rm -rf / "$(x)"')
  })
})

describe('in-VM workspace tokens', () => {
  it('mints a token per boot only when the org enables it, scopes it to siblings, and revokes it on stop', async () => {
    const h = await harness()
    const owner = await h.token('olive', 'acme', 'sandbox', { orgRole: 'owner' })
    const first = (await h.call('POST', '/v1/workspaces', { bearer: owner, body: {} })).body.workspace
    expect(h.vercel.commands.some((c) => c.env?.ORCA_CLOUD_TOKEN_VALUE)).toBe(false)
    expect((await h.call('PUT', '/v1/settings', { bearer: owner, body: { vmCliEnabled: true } })).status).toBe(200)
    await h.call('POST', `/v1/workspaces/${first.id}/sleep`, { bearer: owner })
    await h.call('POST', `/v1/workspaces/${first.id}/wake`, { bearer: owner })
    const install = h.vercel.commands.filter((c) => c.env?.ORCA_CLOUD_TOKEN_VALUE).at(-1)!
    const token = install.env!.ORCA_CLOUD_TOKEN_VALUE!
    expect(token).toMatch(/^orca_ws_/)
    const me = await h.call('GET', '/v1/me', { bearer: token })
    expect(me.body).toMatchObject({ via: 'workspace', workspaceId: first.id, accountId: 'org:acme' })
    // It can make a sibling and see it, but not the org's other workspaces or its own lifecycle.
    const sibling = await h.call('POST', '/v1/workspaces', { bearer: token, body: { name: 'child' } })
    expect(sibling.body.workspace).toMatchObject({ origin: 'vm' })
    const other = (await h.call('POST', '/v1/workspaces', { bearer: owner, body: {} })).body.workspace
    const visible = (await h.call('GET', '/v1/workspaces', { bearer: token })).body.workspaces.map((w: { id: string }) => w.id)
    expect(visible).toEqual([sibling.body.workspace.id])
    expect((await h.call('GET', `/v1/workspaces/${other.id}`, { bearer: token })).status).toBe(404)
    expect((await h.call('POST', `/v1/workspaces/${first.id}/sleep`, { bearer: token })).body.reason).toBe('own_workspace')
    expect((await h.call('POST', '/v1/api-keys', { bearer: token, body: { name: 'x', scopes: ['workspaces:read'] } })).status).toBe(403)
    // Org switch off: the token stops at once; and a stop revokes it for good.
    await h.call('PUT', '/v1/settings', { bearer: owner, body: { vmCliEnabled: false } })
    expect((await h.call('GET', '/v1/me', { bearer: token })).body.reason).toBe('vm_cli_disabled')
    await h.call('PUT', '/v1/settings', { bearer: owner, body: { vmCliEnabled: true } })
    await h.call('POST', `/v1/workspaces/${first.id}/sleep`, { bearer: owner })
    expect((await h.call('GET', '/v1/me', { bearer: token })).status).toBe(401)
  })
})

describe('OpenAPI', () => {
  it('documents every route group and serves the docs page', async () => {
    const h = await harness()
    const doc = openApiDocument('https://api.test')
    expect(Object.keys(doc.paths)).toEqual(Object.keys(OPERATIONS))
    const res = await h.send(new Request('https://sandbox.test/v1/openapi.json'))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { openapi: string }).openapi).toBe('3.1.0')
    const docs = await h.send(new Request('https://sandbox.test/docs'))
    expect(await docs.text()).toContain('Orca Cloud API')
  })
})
